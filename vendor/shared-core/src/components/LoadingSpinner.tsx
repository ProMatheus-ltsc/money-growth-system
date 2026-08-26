/**
 * 全屏加载组件
 */
export function LoadingSpinner({ message = '加载中...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <div className="relative">
        <div className="w-12 h-12 rounded-full border-4 border-slate-200 border-t-blue-600 animate-spin" />
      </div>
      <p className="text-sm text-slate-500 animate-pulse">{message}</p>
    </div>
  );
}
