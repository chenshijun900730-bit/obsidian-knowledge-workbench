const BOUNDED_SEMVER = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export function isStrictBoundedSemver(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  const match = BOUNDED_SEMVER.exec(value);
  if (match === null) return false;
  const prerelease = match[1];
  if (prerelease === undefined) return true;
  if (prerelease.length > 32) return false;
  return prerelease.split(".").every((identifier) => (
    !/^\d+$/u.test(identifier)
    || identifier === "0"
    || !identifier.startsWith("0")
  ));
}
