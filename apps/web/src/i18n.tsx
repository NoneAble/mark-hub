import React, { createContext, useContext, useMemo, useState } from "react";

const dict = {
  zh: {
    appName: "MarkHub",
    login: "登录",
    logout: "退出登录",
    username: "用户名",
    password: "密码",
    publicNav: "公开导航",
    workbench: "工作台",
    admin: "管理",
    adminGroup: "管理",
    bookmarks: "书签",
    folders: "文件夹",
    tags: "标签",
    backup: "备份",
    search: "搜索",
    searchPh: "搜索书签、标签、域名…",
    searchNoResults: "没有匹配的书签",
    searchOpen: "打开",
    add: "添加",
    addBm: "添加书签",
    save: "保存",
    cancel: "取消",
    delete: "删除",
    edit: "编辑",
    import: "导入",
    export: "导出",
    done: "完成",
    editMode: "编辑模式",
    exitEdit: "完成编辑",
    noPublicBookmarks: "暂无公开书签。",
    mustChangePassword: "请先修改默认密码",
    currentPassword: "当前密码",
    newPassword: "新密码",
    newUsername: "新用户名（可选）",
    title: "标题",
    url: "链接",
    description: "描述",
    visibility: "可见性",
    private: "私密",
    unlisted: "不列出",
    public: "公开",
    account: "账户",
    failed: "失败",
    close: "关闭",
    move: "移动",
    batch: "批量",
    favorite: "收藏",
    favorites: "收藏",
    archive: "归档",
    root: "根目录",
    deleteMode: "删除模式",
    shares: "分享",
    share: "分享",
    adminLogin: "管理员登录",
    loginHint: "默认账号 admin · 首次登录请修改密码",
    backToNav: "返回公开导航",
    footNote: "自托管书签导航",
    viewSite: "查看前台",
    empty: "没有匹配的书签",
    all: "全部书签",
    allFolders: "全部",
    tagsField: "标签 (逗号分隔)",
    editBm: "编辑书签",
    newBm: "添加书签",
    unlock: "解锁",
    updateCredentials: "更新凭据",
    updated: "已更新",
  },
  en: {
    appName: "MarkHub",
    login: "Login",
    logout: "Logout",
    username: "Username",
    password: "Password",
    publicNav: "Public Nav",
    workbench: "Dashboard",
    admin: "Admin",
    adminGroup: "ADMIN",
    bookmarks: "Bookmarks",
    folders: "Folders",
    tags: "Tags",
    backup: "Backup",
    search: "Search",
    searchPh: "Search bookmarks, tags, domains…",
    searchNoResults: "No matching bookmarks",
    searchOpen: "Open",
    add: "Add",
    addBm: "Add bookmark",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    import: "Import",
    export: "Export",
    done: "Done",
    editMode: "Edit",
    exitEdit: "Done",
    noPublicBookmarks: "No public bookmarks yet.",
    mustChangePassword: "Please change the default password first",
    currentPassword: "Current password",
    newPassword: "New password",
    newUsername: "New username (optional)",
    title: "Title",
    url: "URL",
    description: "Description",
    visibility: "Visibility",
    private: "Private",
    unlisted: "Unlisted",
    public: "Public",
    account: "Account",
    failed: "Failed",
    close: "Close",
    move: "Move",
    batch: "Batch",
    favorite: "Favorite",
    favorites: "Favorites",
    archive: "Archive",
    root: "Root",
    deleteMode: "Delete mode",
    shares: "Shares",
    share: "Share",
    adminLogin: "Admin Login",
    loginHint: "Default admin · change password on first login",
    backToNav: "Back to public nav",
    footNote: "Self-hosted bookmark hub",
    viewSite: "View site",
    empty: "No matching bookmarks",
    all: "All bookmarks",
    allFolders: "All",
    tagsField: "Tags (comma separated)",
    editBm: "Edit bookmark",
    newBm: "Add bookmark",
    unlock: "Unlock",
    updateCredentials: "Update credentials",
    updated: "Updated",
  },
} as const;

export type Lang = keyof typeof dict;
export type MsgKey = keyof (typeof dict)["zh"];

const Ctx = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: MsgKey) => string;
  toggleLang: () => void;
} | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("markhub_lang");
    if (saved === "en" || saved === "zh") return saved;
    return navigator.language.startsWith("zh") ? "zh" : "en";
  });
  const t = useMemo(() => (k: MsgKey) => dict[lang][k] ?? k, [lang]);
  const set = (l: Lang) => {
    localStorage.setItem("markhub_lang", l);
    setLang(l);
  };
  const toggleLang = () => set(lang === "zh" ? "en" : "zh");
  return <Ctx.Provider value={{ lang, setLang: set, t, toggleLang }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}
