import type { ResultStatus } from "../../lib/domain-schemas.js";

export interface FormattedResult {
  resultStatus: ResultStatus;
  message: string;
}

export function formatResult(resultStatus: ResultStatus, message: string): FormattedResult {
  return { resultStatus, message };
}
