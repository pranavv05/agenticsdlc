import { vi } from "vitest";

// The indexing pipeline logs every stage; keep test output readable. Set SDD_TEST_LOGS=1 to see it.
if (!process.env.SDD_TEST_LOGS) vi.spyOn(console, "log").mockImplementation(() => {});
