import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  title: "Auto-iteration supervisor",
  noSupervisor: "No supervisor is bound yet.",
  supervisorLine: (
    roleSlotId: string,
    generation: number,
    tenureStatus: string,
  ): string => `${roleSlotId} · generation ${generation} · ${tenureStatus}`,
  pendingInbox: (count: number): string => `${count} pending inbox`,
  quotaBlocked: "Quota blocked",
  lastObserved: (when: string): string => `Last observed ${when}`,
  neverObserved: "never",
  noWorkOrders: "No work orders yet.",
  workOrderId: "Work order",
  status: "Status",
  lifecycle: "Lifecycle",
  workerSession: "Worker Session",
  waitingFor: "Waiting for",
  workerBound: "bound",
  workerUnbound: "—",
  waitingForNone: "—",
  unavailable: "Auto-iteration is unavailable for this Project.",
  chooseProfile:
    "Choose a current endpoint, model, and Work Intensity, then run /supervisor again.",
} as const;

const simplifiedChineseCopy = {
  title: "自动迭代主管",
  noSupervisor: "尚未绑定主管。",
  supervisorLine: (
    roleSlotId: string,
    generation: number,
    tenureStatus: string,
  ): string => `${roleSlotId} · 第 ${generation} 代 · ${tenureStatus}`,
  pendingInbox: (count: number): string => `${count} 条待处理 inbox`,
  quotaBlocked: "额度阻塞",
  lastObserved: (when: string): string => `最近观测 ${when}`,
  neverObserved: "从未",
  noWorkOrders: "暂无工单。",
  workOrderId: "工单",
  status: "状态",
  lifecycle: "生命周期",
  workerSession: "Worker 会话",
  waitingFor: "等待",
  workerBound: "已绑定",
  workerUnbound: "—",
  waitingForNone: "—",
  unavailable: "此 Project 暂时无法使用自动迭代。",
  chooseProfile: "请选择当前端点、模型和工作强度，然后再次运行 /supervisor。",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const autoIterationCopy = createLocaleCopy(
  defineCopyLocaleDictionaries(englishCopy, simplifiedChineseCopy),
);
