"use client";
import { Component, type ReactNode } from "react";
import { downloadText } from "@/lib/client";
export default class EditorBoundary extends Component<{ children: ReactNode; content: unknown[]; title: string }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="error-banner" role="alert"><div>暂时无法加载这篇笔记的编辑结构。<small>原始数据仍在本机，没有被清空。请导出原始 JSON 以便恢复。</small></div><button className="text-button" onClick={() => downloadText(`${this.props.title}-原始笔记.json`, JSON.stringify(this.props.content, null, 2), "application/json")}>导出原始数据</button><button className="text-button" onClick={() => this.setState({ error: false })}>重试</button></div>;
  }
}
