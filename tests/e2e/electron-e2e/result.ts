export type ItemId = "1" | "2" | "4" | "8" | "9" | "24";
export type ItemStatus = "settled" | "not-settled";

export type ItemResult = Readonly<{
  item: ItemId;
  status: ItemStatus;
  assertion: string;
  detail: string;
}>;

export function result(
  item: ItemId,
  status: ItemStatus,
  assertion: string,
  detail: string,
): ItemResult {
  return Object.freeze({ item, status, assertion, detail });
}
