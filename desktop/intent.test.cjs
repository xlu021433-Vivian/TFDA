const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('./engine/policy.js');

test('a separate 热 is a drink temperature, not part of the dish name',()=>{
  for(const text of ['珍珠奶茶 大杯 热','珍珠奶茶，大杯，热','热珍珠奶茶 大杯']){
    const request=P.intent(text);
    assert.deepEqual(request.keywords,['珍珠奶茶'],text);
    assert.deepEqual(request.options,{size:'大杯',temperature:'热'},text);
    assert.equal(P.randomPlan([{name:'珍珠奶茶',cents:1200},{name:'冰淇淋红茶',cents:1100}],request,2500)[0].name,'珍珠奶茶');
  }
});
test('hot coffee names keep the coffee and record the temperature',()=>{
  const request=P.intent('一杯热拿铁 25元以内');
  assert.equal(request.category,'咖啡');assert.deepEqual(request.keywords,['拿铁']);assert.equal(request.options.temperature,'热');
});
test('dishes that merely contain 热 are not treated as drink options',()=>{
  const request=P.intent('想吃热干面 一份');
  assert.deepEqual(request.keywords,['热干面']);assert.equal(request.options,undefined);
});
test('existing temperature wording still works',()=>{
  assert.equal(P.intent('一杯热奶茶').options.temperature,'热');
  assert.equal(P.intent('奶茶 热的').options.temperature,'热');
  assert.equal(P.intent('奶茶少糖去冰').options.temperature,'去冰');
});

test('measure words without a number are one serving, not part of the dish',()=>{
  for(const [text,keywords] of [['来份牛肉面',['牛肉','面']],['来碗拉面',['拉面']],['要一份炒饭',['炒饭']],['点份麻辣烫',['麻辣烫']],['整一份黄焖鸡',['黄焖鸡']]]){
    const request=P.intent(text);assert.deepEqual(request.keywords,keywords,text);assert.equal(request.quantity,1,text);
  }
  for(const text of ['来杯奶茶','喝杯奶茶']){const request=P.intent(text);assert.equal(request.category,'奶茶',text);assert.equal(request.keywords,undefined,text);}
  assert.equal(P.intent('中午吃啥都行').keywords,undefined);
  assert.deepEqual(P.intent('想吃点心').keywords,['点心']);assert.deepEqual(P.intent('想吃小吃').keywords,['小吃']);
});
test('dessert requests have their own category and match dessert dishes',()=>{
  for(const text of ['想吃甜品','来点甜的','甜点一份'])assert.equal(P.intent(text).category,'甜品',text);
  assert.equal(P.intent('想吃甜品').keywords,undefined);
  assert.equal(P.intent('芋圆冰粉').category,'甜品');assert.deepEqual(P.intent('来份双皮奶').keywords,['双皮奶']);
  assert.equal(P.randomPlan([{name:'红烧牛肉面',cents:1500},{name:'芒果班戟',cents:1200}],P.intent('想吃甜品'),2500)[0].name,'芒果班戟');
  assert.throws(()=>P.randomPlan([{name:'红烧牛肉面',cents:1500}],P.intent('想吃甜品'),2500),/不会换成其他餐品/);
  assert.equal(P.foodShop('阿婆糖水铺',true),true);assert.equal(P.foodShop('生日蛋糕定制',true),false);
});
test('merchants matching the request are preferred; no match keeps the whole random pool',()=>{
  const shops=[{name:'老王麻辣烫'},{name:'张记黄焖鸡米饭'},{name:'小李饺子馆',body:'招牌：麻辣烫'},{name:'阿婆糖水铺'}];
  assert.deepEqual(P.preferShops(shops,P.intent('想吃麻辣烫')).map(x=>x.name),['老王麻辣烫']);
  assert.deepEqual(P.preferShops(shops,P.intent('想吃甜品')).map(x=>x.name),['阿婆糖水铺']);
  assert.deepEqual(P.preferShops(shops,P.intent('想吃寿司')),shops);
  assert.deepEqual(P.preferShops(shops,P.intent('随便吃点')),shops);
  assert.deepEqual(P.preferShops([{name:'肯德基宅急送'},{name:'老王麻辣烫'}],P.intent('想吃肯德基')).map(x=>x.name),['肯德基宅急送']);
});
test('a brand request picks a main dish in that brand, but a named dish is never replaced',()=>{
  const menu=[{name:'香辣鸡腿堡',cents:1900},{name:'可乐',cents:800}];
  const eligible=wanted=>menu.filter(item=>wanted.category||wanted.keywords?.length||/饭|面|鸡|牛|羊|沙拉|轻食/.test(item.name));
  assert.equal(P.shopPlan(eligible,P.intent('想吃肯德基'),2500,'肯德基宅急送（科技园店）')[0].name,'香辣鸡腿堡');
  assert.throws(()=>P.shopPlan(eligible,P.intent('想吃肯德基'),2500,'老王麻辣烫'),/没有符合/);
  assert.throws(()=>P.shopPlan(eligible,P.intent('宫保鸡丁一份'),2500,'肯德基宅急送'),/没有符合/);
  assert.equal(P.shopPlan(eligible,P.intent('香辣鸡腿堡'),2500,'肯德基宅急送')[0].name,'香辣鸡腿堡');
});
