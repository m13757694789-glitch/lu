type Node = Record<string, unknown>;

// BlockNote's rich-text paste detector misses a single task and * / + lists.
export const hasMarkdownTaskList = (text: string) => /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\](?=[ \t]|$)/m.test(text);

// Repair literal tasks in the editor's copy, preserving IDs, formatting and the
// original stored document until the user edits and saves. Code stays literal.
export function normalizeTaskListBlocks(blocks: unknown[]): unknown[] {
  return blocks.map(value => {
    const block = value as Node;
    const children = Array.isArray(block.children) ? normalizeTaskListBlocks(block.children) : block.children;
    if (!['paragraph', 'bulletListItem', 'numberedListItem'].includes(block.type as string) || !Array.isArray(block.content)) return {...block, children};
    let prefix = '';
    for (const value of block.content) {
      const item = value as Node;
      if (item.type !== 'text' || typeof item.text !== 'string' || (item.styles as Node)?.code) break;
      prefix += item.text;
    }
    const pattern = block.type === 'paragraph'
      ? /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](?:[ \t]+|$)/
      : /^[ \t]*\[([ xX])\](?:[ \t]+|$)/;
    const match = prefix.match(pattern);
    if (!match) return {...block, children};
    let remaining = match[0].length;
    const content = block.content.flatMap(value => {
      const item = value as Node;
      if (!remaining) return [item];
      const text = item.text as string;
      const removed = Math.min(remaining, text.length);
      remaining -= removed;
      return removed === text.length ? [] : [{...item, text: text.slice(removed)}];
    });
    return {...block, type: 'checkListItem', props: {...block.props as Node, checked: match[1].toLowerCase() === 'x'}, content, children};
  });
}
