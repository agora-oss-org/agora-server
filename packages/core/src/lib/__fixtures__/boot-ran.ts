// Test fixture for loadBootModule — its import side effect increments a global counter, so a test can
// prove the module was actually evaluated. NOT a *.test.ts file, so vitest never collects it as a suite.
const g = globalThis as Record<string, unknown>;
g.__agoraBootRan = ((g.__agoraBootRan as number | undefined) ?? 0) + 1;
