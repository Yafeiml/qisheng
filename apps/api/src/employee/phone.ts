export function normalizeChineseMobilePhone(input: string): string {
  let value = input.trim().replace(/[\s()-]/g, "");
  if (value.startsWith("+86")) {
    value = value.slice(3);
  } else if (value.startsWith("0086")) {
    value = value.slice(4);
  } else if (value.startsWith("86") && value.length === 13) {
    value = value.slice(2);
  }
  if (!/^1[3-9]\d{9}$/.test(value)) {
    throw new Error("Phone must be a valid Chinese mainland mobile number");
  }
  return value;
}
