/**
 * Built-in compare-search engines (Smart-Bookmark aligned).
 * Template: %s primary, {q} alias (KD-34). No YouTube built-in.
 */

export interface SearchEngine {
  id: string;
  name: string;
  nameZh: string;
  template: string;
  /** If true, open in new window instead of iframe */
  noIframe?: boolean;
}

export const BUILTIN_ENGINES: SearchEngine[] = [
  {
    id: "google",
    name: "Google",
    nameZh: "Google",
    template: "https://www.google.com/search?q=%s",
    noIframe: true,
  },
  {
    id: "bing",
    name: "Bing",
    nameZh: "Bing",
    template: "https://www.bing.com/search?q=%s",
    noIframe: true,
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    nameZh: "DuckDuckGo",
    template: "https://duckduckgo.com/?q=%s",
    noIframe: true,
  },
  {
    id: "baidu",
    name: "Baidu",
    nameZh: "百度",
    template: "https://www.baidu.com/s?wd=%s",
    noIframe: true,
  },
  {
    id: "github",
    name: "GitHub",
    nameZh: "GitHub",
    template: "https://github.com/search?q=%s",
    noIframe: true,
  },
  {
    id: "stackoverflow",
    name: "Stack Overflow",
    nameZh: "Stack Overflow",
    template: "https://stackoverflow.com/search?q=%s",
    noIframe: true,
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    nameZh: "维基百科",
    template: "https://en.wikipedia.org/w/index.php?search=%s",
    noIframe: true,
  },
  {
    id: "npm",
    name: "npm",
    nameZh: "npm",
    template: "https://www.npmjs.com/search?q=%s",
    noIframe: true,
  },
];

export function buildSearchUrl(template: string, query: string): string {
  const q = encodeURIComponent(query);
  return template.replace(/%s/g, q).replace(/\{q\}/g, q);
}
