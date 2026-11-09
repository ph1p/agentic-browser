import { afterEach } from "vitest";

import { disposeTestRuntimes } from "./runtime.js";

afterEach(disposeTestRuntimes);
