export function requireId(record) {
  if (!record?.id) {
    throw new Error("Record id is required");
  }
  return record;
}
