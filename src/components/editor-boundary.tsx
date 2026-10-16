"use client";
import { Component, type ReactNode } from "react";
import { downloadText } from "@/lib/client";
import { recordUIError } from "@/lib/ui-recovery";
export default class EditorBoundary extends Component<{ children: ReactNode; content: unknown[]; title: string }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(error: Error) { recordUIError(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="error-banner" role="alert"><div>编辑器暂时遇到了问题。<small>笔记没有被清空。请先导出当前正文，再重试打开编辑器。</small></div><button className="text-button" onClick={() => downloadText(`${this.props.title}-原始笔记.json`, JSON.stringify(this.props.content, null, 2), "application/json")}>导出当前正文</button><button className="text-button" onClick={() => this.setState({ error: false })}>重试</button></div>;
  }
}
