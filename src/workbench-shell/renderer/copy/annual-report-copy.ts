import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  title: "Annual report extraction",
  starting: "Starting the annual report job…",
  openFolder: "Open report folder",
  openingFolder: "Opening…",
  exceptions: "Exceptions",
  noExceptions: "No fields need attention.",
  field: "Field",
  value: "Value",
  status: "Status",
  review: "Review",
  unresolvedValue: "No value extracted",
  progress: (done: number, total: number, file: string, field: string): string =>
    `${done} / ${total} fields · current: ${file} · ${field}`,
  stats: (passed: number, human: number, documents: number): string =>
    `${passed} passed · ${human} need a human · ${documents} documents`,
  documentReason: (reason: string): string => `Document reason: ${reason}`,
  exception: (file: string, field: string, reason: string): string =>
    `${file} · ${field}: ${reason}`,
  jobFailure: (reason: string): string => `Job: ${reason}`,
  defaultReason: "The field was not resolved with independently verified evidence.",
  unavailable: "Annual report jobs are unavailable for this Project.",
  chooseProfile:
    "Choose a current endpoint, model, and Work Intensity, then run /annual-report again.",
} as const;

const simplifiedChineseCopy = {
  title: "年报提取",
  starting: "正在启动年报作业…",
  openFolder: "打开报告文件夹",
  openingFolder: "正在打开…",
  exceptions: "异常清单",
  noExceptions: "没有字段需要处理。",
  field: "字段",
  value: "值",
  status: "状态",
  review: "复核",
  unresolvedValue: "未提取到值",
  progress: (done: number, total: number, file: string, field: string): string =>
    `${done} / ${total} 个字段 · 当前：${file} · ${field}`,
  stats: (passed: number, human: number, documents: number): string =>
    `${passed} 已通过 · ${human} 待人工确认 · ${documents} 份文档`,
  documentReason: (reason: string): string => `文档原因：${reason}`,
  exception: (file: string, field: string, reason: string): string =>
    `${file} · ${field}：${reason}`,
  jobFailure: (reason: string): string => `作业：${reason}`,
  defaultReason: "此字段没有通过独立复核并得到有依据的结果。",
  unavailable: "此 Project 暂时无法运行年报作业。",
  chooseProfile: "请选择当前端点、模型和工作强度，然后再次运行 /annual-report。",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const annualReportCopy = createLocaleCopy(
  defineCopyLocaleDictionaries(englishCopy, simplifiedChineseCopy),
);
