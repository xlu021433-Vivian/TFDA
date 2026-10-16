"""美团外卖通用解决方案客户端。依据官方消费者文档，凭证及订单仅存内存。"""
import copy
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from decimal import Decimal, InvalidOperation
from urllib.parse import urlencode, urlsplit

import requests

BASE = 'https://openapi.waimai.meituan.com'
PATHS = {'shops': '/openapi/v1/poilist', 'menu': '/openapi/v1/poi/food',
         'preview': '/openapi/v1/order/preview', 'submit': '/openapi/v1/order/submit'}


class OrderError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class TransportError(OrderError):
    pass


def number(value, label):
    try:
        if isinstance(value, bool):
            raise InvalidOperation
        result = Decimal(str(value))
        if not result.is_finite():
            raise InvalidOperation
        return result
    except (InvalidOperation, ValueError):
        raise OrderError(label + '无效') from None


def money(value):
    amount = number(value, '金额')
    if amount < 0 or amount > 1000000000 or amount != amount.quantize(Decimal('.01')):
        raise OrderError('平台返回了无效金额，已停止操作', 502)
    return amount


def identifier(value):
    if isinstance(value, bool) or not re.fullmatch(r'[1-9]\d{0,18}', str(value)):
        raise OrderError('商家或菜品编号无效')
    return int(value)


def coordinates(longitude, latitude):
    longitude, latitude = number(longitude, '经度'), number(latitude, '纬度')
    if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        raise OrderError('经纬度超出范围，请填写 GCJ-02 坐标的角度值')
    return {'longitude': int(longitude * 1000000), 'latitude': int(latitude * 1000000)}


def signed_form(path, parameters, secret_sign):
    if path not in PATHS.values():
        raise OrderError('不支持的外卖接口')
    if set(parameters) & {'sign', 'secret', 'secret_sign', 'app_secret'}:
        raise OrderError('签名字段不能作为业务参数传递')
    form = {key: str(value) for key, value in parameters.items()}
    canonical = '&'.join(f'{key}={form[key]}' for key in sorted(form))
    # 官方消费者签名规则：URL + ? + 未编码的排序参数 + secret_sign。
    form['sign'] = hashlib.md5((BASE + path + '?' + canonical + secret_sign).encode('utf-8')).hexdigest()
    return form


def remote_json(path, *, form=None, query=None):
    if path not in (*PATHS.values(), '/oauth/access_token'):
        raise OrderError('不支持的外卖接口')
    try:
        with requests.Session() as client:
            client.trust_env = False
            options = dict(timeout=(5, 15), allow_redirects=False, verify=True)
            if form is not None:
                response = client.post(BASE + path, data=form, **options)
            else:
                response = client.get(BASE + path, params=query, **options)
            if not response.ok or response.is_redirect:
                raise TransportError('美团接口暂时不可用，请核对网络及应用权限', 502)
            result = response.json()
    except (requests.RequestException, ValueError):
        raise TransportError('未收到美团的有效响应，请稍后核对结果', 502) from None
    if not isinstance(result, dict):
        raise TransportError('美团接口返回格式无效', 502)
    return result


def pay_url(value):
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 32 for c in value):
        return None
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    try:
        allowed = parsed.port in (None, 443)
    except ValueError:
        return None
    if (parsed.scheme != 'https' or parsed.username or parsed.password or not allowed
            or not any(host == domain or host.endswith('.' + domain) for domain in ('meituan.com', 'sankuai.com'))):
        return None
    return value


class WaimaiSession:
    def __init__(self):
        self.lock = threading.RLock()
        self.timer = None
        self.generation = 0
        self.clear()

    def clear(self):
        with self.lock:
            if self.timer:
                self.timer.cancel()
            self.timer = None
            self.generation += 1
            self.app_id = self.app_secret = self.secret_sign = self.callback = ''
            self.access_token = ''
            self.expires_at = self.configured_until = 0
            self.oauth_state = self.oauth_guard = ''
            self.oauth_until = 0
            self.shops = {}
            self.location = None
            self.catalog = {}
            self.required_tags = set()
            self.menu_shop = None
            self.quote = None
            self.receipt = None
            self.payment = None
            self.uncertain = False

    def _expire(self, generation):
        with self.lock:
            if self.generation == generation:
                self.clear()

    def public(self):
        with self.lock:
            if self.configured_until and time.time() >= self.configured_until:
                self.clear()
            if self.access_token and time.time() >= self.expires_at:
                self.access_token = ''
                self.catalog = {}
                self.quote = None
            return {'configured': bool(self.app_id), 'connected': bool(self.access_token),
                    'expires_in': max(0, int(self.expires_at - time.time())),
                    'uncertain': self.uncertain, 'receipt': copy.deepcopy(self.receipt),
                    'storage': 'memory_only'}

    def configure(self, body, callback):
        app_id, app_secret, secret_sign = (body.get(key) for key in ('app_id', 'app_secret', 'secret_sign'))
        if not isinstance(app_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', app_id):
            raise OrderError('请填写平台分配的应用 ID')
        if any(not isinstance(x, str) or not x or len(x) > 512 or any(c.isspace() for c in x)
               for x in (app_secret, secret_sign)):
            raise OrderError('请填写 AppSecret 和接口签名密钥；密钥不要发到聊天里')
        with self.lock:
            if self.uncertain:
                raise OrderError('请先在官方 App 核对未确认结果的订单，再清除并重新配置', 409)
            self.clear()
            self.app_id, self.app_secret, self.secret_sign, self.callback = app_id, app_secret, secret_sign, callback
            self.configured_until = time.time() + 7200
            self.timer = threading.Timer(7200, self._expire, args=(self.generation,))
            self.timer.daemon = True
            self.timer.start()

    def begin_authorization(self):
        with self.lock:
            if not self.public()['configured']:
                raise OrderError('请先在本机配置已获准的外卖应用')
            state, guard = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.oauth_state = hashlib.sha256(state.encode()).hexdigest()
            self.oauth_guard = hashlib.sha256(guard.encode()).hexdigest()
            self.oauth_until = time.time() + 600
            url = BASE + '/oauth/authorize?' + urlencode({'app_id': self.app_id, 'redirect_uri': self.callback,
                    'response_type': 'code', 'scope': '', 'state': state})
            return url, guard

    def complete_authorization(self, state, guard, code):
        with self.lock:
            self.public()
            if (not self.oauth_state or time.time() > self.oauth_until
                    or not all(isinstance(x, str) and 0 < len(x) <= 4096 for x in (state, guard, code))
                    or not hmac.compare_digest(hashlib.sha256(state.encode()).hexdigest(), self.oauth_state)
                    or not hmac.compare_digest(hashlib.sha256(guard.encode()).hexdigest(), self.oauth_guard)):
                raise OrderError('外卖授权请求已过期或不属于当前浏览器，请重新发起授权', 403)
            self.oauth_state = self.oauth_guard = ''
            result = remote_json('/oauth/access_token', query={'app_id': self.app_id, 'secret': self.app_secret,
                                 'code': code, 'grant_type': 'authorization_code'})
            token, expires = result.get('access_token'), result.get('expires_in')
            if not isinstance(token, str) or not token or len(token) > 8192 or type(expires) is not int or expires <= 0:
                raise OrderError('美团未完成外卖业务授权，请核对应用审核及回调地址', 502)
            # 不调用 userinfo，不读取昵称、头像或用户地址簿，不保留 refresh_token。
            self.access_token = token
            self.expires_at = min(time.time() + expires, self.configured_until)
            self.catalog, self.quote = {}, None

    def _call(self, operation, business):
        if not self.public()['connected']:
            raise OrderError('尚未取得外卖业务授权，请先完成官方 OAuth 授权', 401)
        params = dict(business, app_id=self.app_id, access_token=self.access_token, timestamp=int(time.time()))
        result = remote_json(PATHS[operation], form=signed_form(PATHS[operation], params, self.secret_sign))
        if type(result.get('code')) is not int or result['code'] != 0:
            error = result.get('errorInfo')
            if isinstance(error, dict) and error.get('failCode') == 13001:
                raise OrderError('平台要求短信风控验证，请先在美团官方 App 核对订单和完成验证；软件不会自动重试提交', 409)
            raise OrderError('美团拒绝了本次请求，请核对应用的消费者接口权限与授权状态', 502)
        if not isinstance(result.get('data'), dict):
            raise TransportError('美团未返回有效业务数据', 502)
        return result['data']

    def search(self, longitude, latitude, keyword, consent):
        if consent is not True:
            raise OrderError('请先确认向美团发送本次订餐所需的位置及选择信息')
        if not isinstance(keyword, str) or not 0 < len(keyword.strip()) <= 80:
            raise OrderError('请填写 1 到 80 字的商家或菜品关键词')
        location = coordinates(longitude, latitude)
        with self.lock:
            data = self._call('shops', dict(location, keyword=keyword.strip(), page_index=1, page_size=20))
            rows = data.get('openPoiBaseInfoList')
            if not isinstance(rows, list):
                raise OrderError('平台商家列表格式无效', 502)
            self.shops = {identifier(row['wm_poi_id']): {key: row.get(key) for key in (
                'wm_poi_id', 'name', 'status', 'shipping_fee', 'min_price', 'wm_poi_score', 'distance')}
                for row in rows if isinstance(row, dict) and isinstance(row.get('name'), str)}
            for shop_id, row in self.shops.items():
                row['wm_poi_id'] = str(shop_id)
            self.location = location
            self.catalog, self.quote, self.menu_shop = {}, None, None
            return list(self.shops.values())

    def menu(self, shop_id, guard):
        shop_id = identifier(shop_id)
        with self.lock:
            if shop_id not in self.shops or not self.location:
                raise OrderError('请先查店，再选择本次查询结果中的商家')
            if self.shops[shop_id].get('status') != 1:
                raise OrderError('该商家当前不可配送，请选择其他商家')
            data = self._call('menu', dict(self.location, wm_poi_id=shop_id))
            tags = data.get('food_spu_tags')
            if not isinstance(tags, list):
                raise OrderError('平台菜单格式无效', 502)
            catalog, required_tags = {}, set()
            for tag in tags:
                if not isinstance(tag, dict) or not isinstance(tag.get('spus', []), list):
                    raise OrderError('平台菜品分类格式无效', 502)
                tag_id = str(tag.get('tag', ''))
                if tag.get('tagType') == 1:
                    required_tags.add(tag_id)
                for spu in tag.get('spus', []):
                    if not isinstance(spu, dict) or not isinstance(spu.get('skus', []), list):
                        raise OrderError('平台菜品格式无效', 502)
                    for sku in spu.get('skus', []):
                        if not isinstance(sku, dict):
                            raise OrderError('平台菜品规格格式无效', 502)
                        sku_id = identifier(sku.get('id'))
                        attrs = spu.get('attrs', [])
                        if not isinstance(attrs, list) or any(not isinstance(a, dict) or not isinstance(a.get('values'), list)
                                or not a['values'] or any(not isinstance(v, dict) or 'id' not in v for v in a['values']) for a in attrs):
                            raise OrderError('菜品规格数据不完整，请在官方 App 选择', 502)
                        attrs = [{'name': str(a.get('name', '')), 'values': [
                            {'id': str(identifier(v['id'])), 'value': str(v.get('value', ''))} for v in a['values']]} for a in attrs]
                        if not isinstance(spu.get('name'), str) or not spu['name'].strip():
                            raise OrderError('平台没有返回有效菜品名称', 502)
                        text = ' '.join(str(x or '') for x in (spu['name'], spu.get('description'), sku.get('spec'), sku.get('description')))
                        safe, reason = guard.check(self.shops[shop_id]['name'])
                        if safe:
                            safe, reason = guard.check(text)
                        row = {'id': sku_id, 'name': str(spu.get('name', '')), 'spec': str(sku.get('spec', '')),
                               'price': str(money(sku.get('price'))), 'min_count': max(1, int(sku.get('min_order_count', 1))),
                               'available': spu.get('status') == 0 and sku.get('status') == 0
                                            and type(sku.get('stock')) is int and (sku['stock'] == -1 or sku['stock'] > 0),
                               'stock': sku.get('stock'), 'attrs': attrs, 'safe': safe, 'reason': reason,
                               'tags': {tag_id}, 'guard_text': text}
                        if sku_id in catalog:
                            row['tags'] |= catalog[sku_id]['tags']
                        catalog[sku_id] = row
            self.catalog, self.required_tags, self.menu_shop, self.quote = catalog, required_tags, shop_id, None
            return [dict({key: copy.deepcopy(value) for key, value in row.items() if key not in ('tags', 'guard_text')},
                         id=str(row['id']), required_category=bool(row['tags'] & required_tags))
                    for row in catalog.values()]

    def _payload(self, body, guard):
        if body.get('consent') is not True or body.get('food_confirmed') is not True:
            raise OrderError('请确认本次信息转发，并确认所选菜品符合自己的忌口要求')
        if not self.catalog or not self.menu_shop:
            raise OrderError('请先从平台菜单选餐')
        items = body.get('items')
        if not isinstance(items, list) or not 1 <= len(items) <= 30:
            raise OrderError('请选择 1 到 30 种菜品规格')
        foods, seen, chosen_tags = [], set(), set()
        for item in items:
            if not isinstance(item, dict) or set(item) - {'sku_id', 'count', 'attr_ids'}:
                raise OrderError('所选菜品格式无效')
            sku_id = identifier(item.get('sku_id'))
            row = self.catalog.get(sku_id)
            count = item.get('count')
            if not row or sku_id in seen or not row['available'] or type(count) is not int or not row['min_count'] <= count <= 99:
                raise OrderError('所选菜品、数量或库存无效，请重新选餐')
            if row['stock'] != -1 and count > row['stock']:
                raise OrderError('所选数量超过平台返回的库存')
            attr_ids = item.get('attr_ids', [])
            if not isinstance(attr_ids, list):
                raise OrderError('菜品属性选择无效')
            attr_ids = [identifier(x) for x in attr_ids]
            if len(set(attr_ids)) != len(attr_ids):
                raise OrderError('菜品属性选择重复')
            allowed_ids, attr_names = set(), []
            for attr in row['attrs']:
                options = {identifier(value['id']): str(value.get('value', '')) for value in attr['values']}
                selected = set(attr_ids) & options.keys()
                if len(selected) != 1:
                    raise OrderError('请为每种菜品属性选择一个选项')
                allowed_ids |= options.keys()
                attr_names.extend(options[value] for value in selected)
            if set(attr_ids) - allowed_ids:
                raise OrderError('所选菜品属性不属于本次菜单')
            if (not guard.check(self.shops[self.menu_shop]['name'])[0]
                    or not guard.check(row['guard_text'] + ' ' + ' '.join(attr_names))[0]):
                raise OrderError('所选商家、菜品或属性触发忌口规则，已停止预览')
            seen.add(sku_id)
            chosen_tags |= row['tags']
            foods.append({'wm_food_sku_id': sku_id, 'count': count, 'food_spu_attr_ids': attr_ids})
        if not self.required_tags <= chosen_tags:
            raise OrderError('菜单存在必选分类，请补全后再预览')
        receiver = body.get('receiver')
        if not isinstance(receiver, dict) or set(receiver) - {'name', 'phone', 'address', 'longitude', 'latitude', 'note'}:
            raise OrderError('收货信息格式无效')
        for key, maximum in (('name', 40), ('address', 200), ('note', 200)):
            value = receiver.get(key, '')
            if not isinstance(value, str) or len(value) > maximum or (key != 'note' and not value.strip()):
                raise OrderError('请填写完整的收货人、地址及有效备注')
        if not isinstance(receiver.get('phone'), str) or not re.fullmatch(r'1[3-9]\d{9}', receiver['phone']):
            raise OrderError('请填写收货手机号；只在本机和美团本次请求中使用')
        address = coordinates(receiver.get('longitude'), receiver.get('latitude'))
        return {'wm_ordering_list': {'wm_poi_id': self.menu_shop, 'delivery_time': 0, 'pay_type': 2, 'food_list': foods},
                'wm_ordering_user': {'user_longitude': self.location['longitude'], 'user_latitude': self.location['latitude'],
                    'addr_longitude': address['longitude'], 'addr_latitude': address['latitude'],
                    'user_name': receiver['name'].strip(), 'user_phone': receiver['phone'],
                    'user_address': receiver['address'].strip(), 'user_caution': receiver.get('note', '')}}

    def _quote(self, payload, budget, guard):
        data = self._call('preview', {'payload': json.dumps(payload, ensure_ascii=False, separators=(',', ':'))})
        if type(data.get('code')) is not int or data['code'] != 0:
            raise OrderError('平台无法预览所选订单，请检查配送范围、起送价、库存和必选菜品', 409)
        if data.get('wm_ordering_unavaliable_food_vo_list') or data.get('min_count_foodlist'):
            raise OrderError('平台返回不可用菜品或不足起送份数，已停止操作', 409)
        order, lines, token = data.get('wm_ordering_preview_order_vo'), data.get('wm_ordering_preview_detail_vo_list'), data.get('token')
        if not isinstance(order, dict) or not isinstance(lines, list) or not lines or not isinstance(token, str) or not token:
            raise OrderError('平台订单预览缺少必要信息，已停止操作', 502)
        if identifier(order.get('wm_poi_id')) != self.menu_shop:
            raise OrderError('平台预览商家与选择不一致，已停止操作', 502)
        actual, display_lines = {}, []
        for line in lines:
            if not isinstance(line, dict):
                raise OrderError('平台预览菜品格式无效', 502)
            sku_id, count = identifier(line.get('wm_food_sku_id')), line.get('count')
            if type(count) is not int or count < 1 or sku_id in actual:
                raise OrderError('平台预览菜品格式不一致，已停止操作', 502)
            attrs = line.get('wm_ordering_preview_food_spu_attr_list', [])
            if not isinstance(attrs, list) or any(not isinstance(a, dict) or 'id' not in a for a in attrs):
                raise OrderError('平台预览菜品属性不完整', 502)
            chosen = self.catalog.get(sku_id)
            if not chosen or line.get('food_name') != chosen['name'] or str(line.get('spec', '')) != chosen['spec']:
                raise OrderError('平台预览菜品或规格与所选菜单不一致，请重新读取菜单', 409)
            names = [str(a.get('value', '')) for a in attrs]
            text = ' '.join([str(line.get('food_name', '')), str(line.get('spec', '')), *names])
            if not guard.check(str(order.get('poi_name', '')))[0] or not guard.check(text)[0]:
                raise OrderError('平台预览菜品触发忌口规则，已停止操作', 409)
            actual[sku_id] = (count, sorted(identifier(a['id']) for a in attrs))
            display_lines.append({'sku_id': str(sku_id), 'name': str(line.get('food_name', '')),
                                  'spec': str(line.get('spec', '')), 'count': count, 'attributes': names})
        expected = {x['wm_food_sku_id']: (x['count'], sorted(x['food_spu_attr_ids'])) for x in payload['wm_ordering_list']['food_list']}
        if actual != expected:
            raise OrderError('平台预览的菜品、规格或数量与选择不一致，已停止操作', 409)
        total = money(order.get('total'))
        if total > money(budget):
            raise OrderError('平台预览总价超过设置中的预算上限，已停止操作', 409)
        phone = order.get('recipient_phone')
        if not all(isinstance(order.get(key), str) and order[key] for key in ('recipient_name', 'recipient_address', 'recipient_phone', 'poi_name')):
            raise OrderError('平台没有返回完整收货信息，已停止操作', 502)
        recipient = payload['wm_ordering_user']
        if phone != recipient['user_phone'] or order['recipient_name'] != recipient['user_name']:
            raise OrderError('平台预览的收货人信息与填写不一致，已停止操作', 409)
        visible = {'total': str(total), 'shop': order['poi_name'], 'items': display_lines,
                   'recipient_name': order['recipient_name'], 'recipient_address': order['recipient_address'],
                   'phone_masked': phone[:3] + '****' + phone[-4:]}
        return {'token': token, 'visible': visible, 'total': total}

    def preview(self, body, budget, guard):
        with self.lock:
            if self.uncertain:
                raise OrderError('上次提交结果未知，请先在官方 App 核对订单，软件不会再次提交', 409)
            self.quote = None
            payload = self._payload(body, guard)
            result = self._quote(payload, budget, guard)
            self.quote = dict(result, payload=payload, ticket=secrets.token_urlsafe(32), until=time.time() + 180, spent=False)
            return dict(result['visible'], ticket=self.quote['ticket'], expires_in=180)

    def submit(self, ticket, confirmed, dry_run, budget, guard):
        with self.lock:
            quote = self.quote
            if self.uncertain or not quote or quote['spent'] or time.time() > quote['until']:
                raise OrderError('预览已失效或提交过，请先核对官方订单，再重新预览', 409)
            if confirmed is not True or not isinstance(ticket, str) or not hmac.compare_digest(ticket, quote['ticket']):
                raise OrderError('请核对当前预览并明确确认创建订单', 403)
            if dry_run:
                return {'ok': True, 'created': False, 'message': '试运行完成：未创建订单、未支付。真实提交需关闭设置中的试运行，再确认当前预览。'}
            fresh = self._quote(quote['payload'], budget, guard)
            if fresh['visible'] != quote['visible']:
                self.quote = None
                raise OrderError('价格、菜品或收货信息发生变化，请重新预览并确认', 409)
            payload = copy.deepcopy(quote['payload'])
            payload.update(pay_source=3, token=fresh['token'])
            quote['spent'] = True  # 发请求前消耗票据；并发或重复点击不能重复提交。
            try:
                data = self._call('submit', {'payload': json.dumps(payload, ensure_ascii=False, separators=(',', ':'))})
            except TransportError:
                self.uncertain = True
                raise OrderError('提交结果未知，请到美团官方 App 核对订单；软件已禁止自动重试，避免重复下单', 409) from None
            if data.get('code') != 0 or type(data.get('code')) is not int:
                if type(data.get('code')) is not int:
                    self.uncertain = True
                    raise OrderError('提交响应缺少明确状态，请先在官方 App 核对订单；软件不会重试', 409)
                raise OrderError('美团未完成提交，可能存在配送费变化、库存变化或平台风控；请先核对官方订单，再重新预览', 409)
            try:
                order_id = identifier(data.get('order_id'))
            except OrderError:
                self.uncertain = True
                raise OrderError('美团未返回明确订单编号，请在官方 App 核对；软件不会重试提交', 409) from None
            self.payment = pay_url(data.get('payUrl'))
            self.receipt = {'order_id': str(order_id), 'total': quote['visible']['total'], 'payment_available': bool(self.payment)}
            # 不保存收货信息和预览令牌到文件或普通历史记录。
            self.quote = None
            return {'ok': True, 'created': True, 'receipt': copy.deepcopy(self.receipt),
                    'message': '订单已创建，尚未验证支付结果；请在美团官方收银台或官方 App 核对并付款。'}
