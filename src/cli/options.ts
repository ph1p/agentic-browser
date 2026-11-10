import { InvalidArgumentError } from "commander";
import {
  INTERACTIVE_ELEMENT_ROLES,
  type InteractiveElementRole,
} from "../session/browser-controller.js";

export function parseRoles(value: string): InteractiveElementRole[] {
  const roles = value
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const valid: readonly string[] = INTERACTIVE_ELEMENT_ROLES;
  const unknown = roles.filter((r) => !valid.includes(r));
  if (unknown.length > 0) {
    throw new InvalidArgumentError(
      `unknown role(s) ${unknown.join(", ")}; valid: ${INTERACTIVE_ELEMENT_ROLES.join(", ")}`,
    );
  }
  return roles as InteractiveElementRole[];
}

export const collect = (value: string, previous: string[] = []) => [...previous, value];

export const FRAME_HELP = "iframe selector to run in (cross-origin frames supported)";
export const INTENT_HELP =
  'task this step belongs to, e.g. "log in"; later steps on the same site join it, "" ends it (see agent memory-search)';

/** Resolves `<selector>` or `--text` (substring; `--exact` for exact match) to one locator. */
export function resolveTarget(
  selector: string | undefined,
  options: { text?: string; exact?: boolean },
) {
  if (selector && options.text) throw new Error("Pass either a selector or --text, not both");
  if (options.text) {
    return options.exact ? `text=${JSON.stringify(options.text)}` : `text=${options.text}`;
  }
  if (!selector) throw new Error("Missing target: pass a selector or --text <text>");
  return selector;
}

/** Options shared by the agent commands that act on one element. */
export type StepOptions = { fallback: string[]; frame?: string };
export type TargetOptions = StepOptions & { text?: string; exact?: boolean };
