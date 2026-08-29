import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// 移动端响应式全局基线：触控目标 44px / 输入 16px 防聚焦缩放 / safe-area / dvh / modal-clamp / 容器查询 / 表格滚动
import '@shared/core/styles/responsive.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
