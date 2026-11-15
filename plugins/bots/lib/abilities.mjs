/**
 * What a bot can already do inside DeepSeek Harness, grouped the way a user
 * thinks about it ("browse the web", "write code") instead of tool names.
 * Turning an ability off denies its tools to that bot only. Tools a running
 * Harness does not have are simply skipped.
 *
 * @module @kadaliao/dsh-bots/lib/abilities
 */

const L = (en, zh) => ({ en, zh });

export const ABILITIES = [
  {
    id: 'web',
    name: L('Web search & reading', '联网搜索与阅读'),
    description: L('Search the web and read pages.', '搜索网络、阅读网页。'),
    tools: ['web_search', 'web_fetch'],
  },
  {
    id: 'files',
    name: L('Files', '读写文件'),
    description: L('Read, write, edit and search files in its workspace.', '在工作目录里读、写、改、搜文件。'),
    tools: ['read', 'write', 'edit', 'glob', 'grep', 'read_image', 'working_directory'],
  },
  {
    id: 'code',
    name: L('Run commands & code', '运行命令与代码'),
    description: L('Run shell commands, scripts and background jobs: build, test, deploy, call CLIs.', '执行终端命令、脚本与后台任务：构建、测试、部署、调用命令行工具。'),
    tools: ['bash', 'job_list', 'job_output', 'job_kill', 'load_workspace_dependencies'],
  },
  {
    id: 'office',
    name: L('Office documents', 'Office 文档'),
    description: L('Make and check Word, Excel, PowerPoint and PDF files.', '生成并检查 Word、Excel、PPT 和 PDF。'),
    tools: ['office_render', 'office_convert', 'office_recalculate'],
  },
  {
    id: 'images',
    name: L('Image generation', 'AI 作图'),
    description: L('Draw pictures, posters and GIFs (Images plugin).', '画图、海报、动图（图片插件）。'),
    tools: ['generate_image'],
  },
  {
    id: 'delegate',
    name: L('Sub-agents & workflows', '子代理与工作流'),
    description: L('Split big jobs across helper agents inside its own conversation.', '在自己的会话里把大任务拆给子代理并行完成。'),
    tools: ['subagent', 'subagent_fork', 'workflow', 'send_message', 'wait_agent', 'list_agents', 'list_subagent_models', 'interrupt_agent', 'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'],
  },
  {
    id: 'schedule',
    name: L('Own reminders', '自建提醒'),
    description: L('Create Harness scheduled tasks directly (bot_schedule stays available).', '直接创建 Harness 定时任务（bot_schedule 始终可用）。'),
    tools: ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'],
  },
  {
    id: 'ask',
    name: L('Ask you questions', '向你提问'),
    description: L('Pause and ask you to choose or confirm.', '暂停下来请你选择或确认。'),
    tools: ['ask_user_question'],
  },
  {
    id: 'deliver',
    name: L('Hand over files', '交付文件'),
    description: L('Present finished files as cards you can open.', '把做好的文件以卡片形式交给你。'),
    tools: ['present'],
  },
  {
    id: 'plugins',
    name: L('Manage Harness plugins', '管理 Harness 插件'),
    description: L('Install or change Harness plugins. Rarely needed by a bot.', '安装或修改 Harness 插件，bot 一般不需要。'),
    tools: ['plugin_manager'],
    risky: true,
  },
];

/** Ability ids whose tools are all in `deny`. */
export function disabledAbilities(deny) {
  const set = new Set(deny);
  return ABILITIES.filter((a) => a.tools.every((t) => set.has(t))).map((a) => a.id);
}

/** The deny list for a set of disabled abilities, plus any extra tool names. */
export function denyFor(disabledIds, extra = []) {
  const out = new Set(extra);
  for (const a of ABILITIES) if (disabledIds.includes(a.id)) for (const t of a.tools) out.add(t);
  return [...out];
}
