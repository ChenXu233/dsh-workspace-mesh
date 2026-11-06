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
  'row.hint': '在 {node} 上 · {path}',
  'dialog.title': '添加远程工作区',
  'dialog.hint': '工作区会创建在选中的机器上；本机不复制目录，也不登记本地记录。',
  'dialog.node': '机器',
  'dialog.path': '位置',
  'dialog.up': '上一级',
  'dialog.empty': '没有子文件夹',
  'dialog.create': '在此新建工作区',
  'dialog.noNodes': '还没有可用的远端节点：先在 mesh 配置里配对一台机器。',
  'dialog.loading': '正在读取目录…',
  'dialog.close': '关闭',
  'dialog.cancel': '取消',
  'offline': '离线',
} as const

/** One key of this package's namespace. */
export type RemoteKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<RemoteKey, string> = {
  'section.title': 'Remote workspaces',
  'section.add': 'Add a remote workspace',
  'section.empty': 'No remote workspace yet',
  'row.hint': 'on {node} · {path}',
  'dialog.title': 'Add remote workspace',
  'dialog.hint': 'The workspace is created on the chosen machine; nothing is copied or recorded locally.',
  'dialog.node': 'Machine',
  'dialog.path': 'Location',
  'dialog.up': 'Up',
  'dialog.empty': 'No subfolders',
  'dialog.create': 'New workspace here',
  'dialog.noNodes': 'No peer node yet: pair a machine in the mesh configuration first.',
  'dialog.loading': 'Reading directories…',
  'dialog.close': 'Close',
  'dialog.cancel': 'Cancel',
  'offline': 'offline',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This package's own namespace, registered under {@link NS}. */
    workspaceRemote: RemoteKey
  }
}

/** The translate seat this package's components receive. */
export type RemoteTranslate = (key: RemoteKey, params?: Record<string, string | number>) => string
