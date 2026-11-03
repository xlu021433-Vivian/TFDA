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
