/**
 * 高频经验教训关键词：按出现频次排布为大小不同的标签云近似展示。
 * 提取自 root-cause-analysis 项目（公共统计组件，标签云，直接复用）。
 * @param keywords 关键词及其出现次数
 */
export function KeywordList({ keywords }: { keywords: { keyword: string; count: number }[] }) {
  if (keywords.length === 0) {
    return (
    <div className="py-8 text-center">
      <p className="text-sm text-slate-400">暂无经验教训数据</p>
      <p className="mt-2 text-xs text-slate-300">完成分析并填写「验证方式」后，经验教训将自动汇总于此</p>
    </div>
  );
  }
  // 以出现次数最多的关键词为基准，把每个词的字体大小按比例缩放在 0.75rem ~ 1.5rem 之间
  const maxCount = Math.max(...keywords.map((k) => k.count));
  return (
    <div className="flex flex-wrap gap-2">
      {keywords.map((k) => {
        const scale = 0.75 + (k.count / maxCount) * 0.75;
        return (
          <span
            key={k.keyword}
            className="rounded-full bg-sky-50 px-3 py-1 text-sky-700"
            style={{ fontSize: `${scale}rem` }}
            title={`出现 ${k.count} 次`}
          >
            {k.keyword}
          </span>
        );
      })}
    </div>
  );
}
