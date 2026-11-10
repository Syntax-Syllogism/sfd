// Shared by the CLI and rewrite hook so invalid sync selectors stay with sf.
/**
 * @param {{ classNames?: string[], tests?: string[], suiteNames?: unknown, testLevel?: string }} selection
 * @returns {string | undefined}
 */
export function synchronousTestError({ classNames = [], tests = [], suiteNames, testLevel }) {
  if (suiteNames !== undefined) return "Synchronous test runs do not support suites.";
  if (testLevel !== undefined && testLevel !== "RunSpecifiedTests") {
    return "Synchronous test runs require --test-level RunSpecifiedTests.";
  }
  const classes = new Set([
    ...classNames,
    ...tests.map(test => test.includes(".") ? test.slice(0, test.lastIndexOf(".")) : test)
  ]);
  if (!classes.size) return "Synchronous runs need one class: -n <Class> or -t <Class.method>.";
  if (classes.size > 1) {
    return "Synchronous test runs can include test methods from only one Apex class. Omit --synchronous or include tests from only one class.";
  }
}
