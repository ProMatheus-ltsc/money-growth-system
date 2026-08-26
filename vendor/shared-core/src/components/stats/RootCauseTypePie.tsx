/**
 * 环形分布图（RootCauseTypePie）：基于通用 { name, value } 数据渲染 recharts 环形饼图。
 * 环形（donut）样式，颜色按顺序循环取自 COLORS。
 * 提取自 root-cause-analysis 项目（原为"根因类型分布饼图"，公共统计组件）。
 * 输入已泛化：业务类型 RootCauseTypeCount 已移除，改为通用结构
 * { name: string; value: number; type?: string }[]（type 可选，用于扇区唯一 key）。
 */
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

/** 饼图配色盘：按数据顺序循环取色，保证每个扇区都有不同颜色 */
const COLORS = ['#0ea5e9', '#14b8a6', '#f59e0b', '#8b5cf6', '#f43f5e', '#84cc16', '#6366f1', '#64748b'];

/** 通用饼图数据项：name 扇区名称、value 扇区数值、type 可选唯一标识（用于扇区 key，缺省回退 name） */
interface PieDatum {
  name: string;
  value: number;
  type?: string;
}

/**
 * 环形分布图组件。
 * @param data 通用计数数据列表（name 用于名称、value 用于扇区大小），空数组时显示占位文案
 */
export function RootCauseTypePie({ data }: { data: PieDatum[] }) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-400">暂无数据</p>;
  }
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={data.length > 1 ? 2 : 0}
            label={({ name, value }) => `${name} (${value})`}
            labelLine={data.length > 1}
          >
            {data.map((entry, idx) => (
              <Cell key={entry.type ?? entry.name} fill={COLORS[idx % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => [`${value} 条 (${Math.round((Number(value) / total) * 100)}%)`, '数量']} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
