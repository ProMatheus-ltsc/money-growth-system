import { renderToString } from 'react-dom/server';
import { FinanceStackedArea } from '../vendor/shared-core/src/components/visualize/finance/FinanceStackedArea';
import { FinanceTreemap } from '../vendor/shared-core/src/components/visualize/finance/FinanceTreemap';
import { FinanceSankey } from '../vendor/shared-core/src/components/visualize/finance/FinanceSankey';
import { FinanceWaterfall } from '../vendor/shared-core/src/components/visualize/finance/FinanceWaterfall';
import { FinanceCompareBar } from '../vendor/shared-core/src/components/visualize/finance/FinanceCompareBar';
import { FinanceDonut } from '../vendor/shared-core/src/components/visualize/finance/FinanceDonut';

let pass=0, fail=0;
const chk=(n:string,fn:()=>string)=>{try{fn();pass++;console.log('  ✓ '+n);}catch(e){fail++;console.log('  ✗ '+n+': '+(e as Error).message);}};
console.log('finance 图表 SSR（导入与渲染不抛错）：');
chk('StackedArea',()=>renderToString(<FinanceStackedArea months={['2026-07','2026-08']} series={[{module:'现金',points:[{month:'2026-07',amount:1},{month:'2026-08',amount:2}]}]} actual={[1,2]} expected={[1.1,2.1]} />));
chk('Treemap',()=>renderToString(<FinanceTreemap data={[{name:'现金',amount:100,children:[{name:'银行A',amount:100}]}]} />));
chk('Sankey',()=>renderToString(<FinanceSankey flows={[{source:'职业收入',target:'总收入',value:100},{source:'总收入',target:'结余/净储蓄',value:40}]} />));
chk('Waterfall',()=>renderToString(<FinanceWaterfall openingTotal={100} items={[{label:'结余',delta:20},{label:'负债变动',delta:-5}]} closingTotal={115} />));
chk('CompareBar',()=>renderToString(<FinanceCompareBar groups={[{module:'现金',targetRate:0.0025,actualRate:0.004},{module:'中长期',targetRate:0.029,actualRate:null}]} />));
chk('Donut',()=>renderToString(<FinanceDonut slices={[{name:'短期',value:5000},{name:'长期',value:800000}]} centerValue="805,000" centerLabel="期末总负债" />));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if(fail>0) process.exit(1);
