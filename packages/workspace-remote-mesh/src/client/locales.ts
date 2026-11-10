/**
 * This package's own locale namespace.
 *
 * It is deliberately not the shipped `workspace` namespace: the locale service
 * refuses a second registration for a locale that already exists, and the
 * shipped browser owns that one. A separate namespace also keeps our copy
 * separable from upstream's.
 */
export const NS = 'workspaceRemote'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.title': '远程工作区',
  'section.add': '添加远程工作区',
  'section.empty': '还没有远程工作区',
  'section.noSessions': '这台机器上还没有会话',
  'section.current': '当前会话',
  'row.hint': '在 {node} 上 · {path}',
  'session.remoteHint': '会话在 {node} 上运行；本机不持有它的日志与运行时。',
  'target.aria': '派遣目标：{node} · {name}；点击清除',
  'target.clear': '派遣目标在 {node}；点击清除',
  'dialog.title': '添加远程工作区',
  'dialog.hint': '工作区会创建在选中的机器上；本机不复制目录，也不登记本地记录。',
  'dialog.node': '机器',
  'dialog.path': '位置',
  'dialog.up': '上一级',
  'dialog.empty': '没有子文件夹',
  'dialog.create': '在此新建工作区',
  'dialog.noNodes': '还没有可用的远端节点：先在 mesh 配置里配对一台机器。',
  'dialog.chooseMachine': '选择一台机器打开它的目录',
  'dialog.error': '创建失败',
  'browser.title': '选择工作区目录',
  'browser.home': '主目录',
  'browser.newFolder': '新建文件夹',
  'browser.folderName': '文件夹名称',
  'browser.createIn': '在"{name}"中新建文件夹',
  'browser.untitledFolder': '未命名文件夹',
  'browser.create': '创建',
  'browser.cancel': '取消',
  'browser.open': '在此新建工作区',
  'browser.editPath': '编辑路径',
  'browser.loading': '加载中…',
  'browser.truncated': '文件夹过多，仅显示开头部分。',
  'browser.showHidden': '显示隐藏文件',
  'dialog.loading': '正在读取目录…',
  'dialog.close': '关闭',
  'dialog.cancel': '取消',
  'offline': '离线',
  'page.back': '回到本机',
  'page.empty': '这个工作区还没有消息',
  'page.emptyHint': '在下面的输入框里写第一条消息，会话会在 {node} 上进行。',
  'page.running': '对端正在运行',
  'page.failed': '读取失败',
  'page.session': '会话 {id}',
} as const

/** One key of this package's namespace. */
export type RemoteKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<RemoteKey, string> = {
  'section.title': 'Remote workspaces',
  'section.add': 'Add a remote workspace',
  'section.empty': 'No remote workspace yet',
  'section.noSessions': 'No conversation on this machine yet',
  'section.current': 'Current conversation',
  'row.hint': 'on {node} · {path}',
  'session.remoteHint': 'This conversation runs on {node}; its log and runtime never leave that machine.',
  'target.aria': 'Dispatch target: {node} · {name}; click to clear',
  'target.clear': 'Dispatches go to {node}; click to clear',
  'dialog.title': 'Add remote workspace',
  'dialog.hint': 'The workspace is created on the chosen machine; nothing is copied or recorded locally.',
  'dialog.node': 'Machine',
  'dialog.path': 'Location',
  'dialog.up': 'Up',
  'dialog.empty': 'No subfolders',
  'dialog.create': 'New workspace here',
  'dialog.noNodes': 'No peer node yet: pair a machine in the mesh configuration first.',
  'dialog.chooseMachine': 'Choose a machine to browse its folders',
  'dialog.error': 'Could not create',
  'browser.title': 'Select Workspace Directory',
  'browser.home': 'Home',
  'browser.newFolder': 'New folder',
  'browser.folderName': 'Folder name',
  'browser.createIn': 'New folder in "{name}"',
  'browser.untitledFolder': 'Untitled folder',
  'browser.create': 'Create',
  'browser.cancel': 'Cancel',
  'browser.open': 'Create the workspace here',
  'browser.editPath': 'Edit path',
  'browser.loading': 'Loading…',
  'browser.truncated': 'Too many folders to list; only the beginning is shown.',
  'browser.showHidden': 'Show hidden files',
  'dialog.loading': 'Reading directories…',
  'dialog.close': 'Close',
  'dialog.cancel': 'Cancel',
  'offline': 'offline',
  'page.back': 'Back to this machine',
  'page.empty': 'No message in this workspace yet',
  'page.emptyHint': 'Write the first message below; the conversation runs on {node}.',
  'page.running': 'The peer is running',
  'page.failed': 'Read failed',
  'page.session': 'session {id}',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This package's own namespace, registered under {@link NS}. */
    workspaceRemote: RemoteKey
  }
}

/** The translate seat this package's components receive. */
export type RemoteTranslate = (key: RemoteKey, params?: Record<string, string | number>) => string