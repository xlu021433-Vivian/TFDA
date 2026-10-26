const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=(()=>{try{return require('jsdom');}catch{return require('../.tool-cache/browser-tests/node_modules/jsdom');}})();
const reader=require('./cashier-reader.js');
const id='4402356522089986176';
const canonical='https://h5.waimai.meituan.com/waimai/mindex/order-detail?mtOrderViewId='+id;
const url='https://mpay.meituan.com/resource/icashier/s/index.html?pay_success_url='+encodeURIComponent(canonical+'&token=private')+'&pay_token=secret&redr_url='+encodeURIComponent('https://example.com/');
function fixture(t,body='支付订单 交易剩余时间14:39 支付金额 ¥23.90 测试餐厅-'+id){const d=new JSDOM('<body>'+body+'</body>');t.after(()=>d.window.close());return d.window.document;}
test('read-only cashier recognition matches the receipt and removes all payment tokens',t=>{
  const result=reader.read(fixture(t),url);assert.deepEqual(result,{orderId:id,total:2390,status:'unpaid',url:canonical});assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes('private'));
});
test('cashier lookalikes, mismatched receipts, paid or incomplete pages cannot confirm an order',t=>{
  const doc=fixture(t);
  for(const location of [url.replace('mpay.meituan.com','mpay.meituan.com.evil'),url.replace('mpay.meituan.com','mpay.meituan.com:8443'),url.replace('/s/index.html','/other'),url.replace('https:','http:'),url.replace(encodeURIComponent('h5.waimai.meituan.com'),encodeURIComponent('evil.example'))])assert.equal(reader.read(doc,location),null);
  for(const body of ['支付订单 支付金额 ¥23.90 测试餐厅-'+id,'支付订单 交易剩余时间14:39 支付金额 ¥23.90 测试餐厅-123456789','支付订单 交易剩余时间14:39 支付成功 支付金额 ¥23.90 测试餐厅-'+id])assert.equal(reader.read(fixture(t,body),url),null);
});
