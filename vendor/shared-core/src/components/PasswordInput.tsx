/**
 * PasswordInput — 密码输入框组件
 *
 * 提取自 personal_review_system/src/components/PasswordInput.tsx
 *
 * 封装了密码输入的通用交互：
 * - 支持明文/密文切换（通过眼睛图标按钮）
 * - 可选的 label 标签
 * - 长度限制（maxLength）
 * - 自动聚焦（autoFocus）
 *
 * 切换按钮设置 tabIndex={-1} 防止 Tab 键聚焦到按钮上。
 */
import React from 'react';

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  showPassword: boolean;
  onToggleVisibility: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  maxLength?: number;
  label?: string;
}

const PasswordInput: React.FC<PasswordInputProps> = ({
  value,
  onChange,
  showPassword,
  onToggleVisibility,
  placeholder = '请输入密码',
  autoFocus = false,
  maxLength = 20,
  label,
}) => {
  return (
    <div>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          type={showPassword ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-colors"
          maxLength={maxLength}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          onClick={onToggleVisibility}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          tabIndex={-1}
        >
          {showPassword ? '🙈' : '👁️'}
        </button>
      </div>
    </div>
  );
};

export default PasswordInput;
