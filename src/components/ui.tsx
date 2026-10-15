"use client";
import { Dialog, DropdownMenu } from "radix-ui";
import { X } from "lucide-react";
export function Modal({ open, onOpenChange, title, description, children, wide = false }: { open: boolean; onOpenChange: (value: boolean) => void; title: string; description?: string; children: React.ReactNode; wide?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`dialog-content ${wide ? "wide" : ""}`}><Dialog.Title className="dialog-title">{title}</Dialog.Title><Dialog.Description className="dialog-description">{description || ""}</Dialog.Description><Dialog.Close className="icon-button dialog-close" aria-label="关闭"><X size={18} /></Dialog.Close>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function Menu({ trigger, children, label }: { trigger: React.ReactNode; children: React.ReactNode; label: string }) {
  return <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-button menu-trigger" aria-label={label}>{trigger}</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="dropdown-content" align="end" sideOffset={6}>{children}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;
}
export function MenuItem({ children, onSelect, danger = false }: { children: React.ReactNode; onSelect: () => void; danger?: boolean }) {
  return <DropdownMenu.Item className={`dropdown-item ${danger ? "danger" : ""}`} onSelect={onSelect}>{children}</DropdownMenu.Item>;
}
