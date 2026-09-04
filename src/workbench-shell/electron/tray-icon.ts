export const workbenchTrayMark = Object.freeze({
  glyph: "U",
  gradientAngleDegrees: 150,
  codexColor: "#22d3ff",
  claudeColor: "#ff9a3c",
  radius: 7,
  size: 18,
  textColor: "#0a0a0b",
  fontSize: 11,
  fontWeight: 800,
} as const);

// These endpoints are the CSS 150deg direction projected across a square:
// d = (sin(150deg), -cos(150deg)); length = |dx| + |dy|.
const gradientStartX = "15.8494%";
const gradientStartY = "-9.1506%";
const gradientEndX = "84.1506%";
const gradientEndY = "109.1506%";

export const workbenchTrayMarkSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${workbenchTrayMark.size}" height="${workbenchTrayMark.size}" viewBox="0 0 ${workbenchTrayMark.size} ${workbenchTrayMark.size}">` +
  `<defs><linearGradient id="mark-gradient" x1="${gradientStartX}" y1="${gradientStartY}" x2="${gradientEndX}" y2="${gradientEndY}" data-css-angle="${workbenchTrayMark.gradientAngleDegrees}deg">` +
  `<stop offset="0" stop-color="${workbenchTrayMark.codexColor}"/><stop offset="1" stop-color="${workbenchTrayMark.claudeColor}"/>` +
  `</linearGradient></defs>` +
  `<rect width="${workbenchTrayMark.size}" height="${workbenchTrayMark.size}" rx="${workbenchTrayMark.radius}" fill="url(#mark-gradient)"/>` +
  `<text x="9" y="12.5" text-anchor="middle" fill="${workbenchTrayMark.textColor}" font-family="Inter,Segoe UI,sans-serif" font-size="${workbenchTrayMark.fontSize}" font-weight="${workbenchTrayMark.fontWeight}">${workbenchTrayMark.glyph}</text>` +
  `</svg>`;

// Mechanically rasterized from workbenchTrayMarkSvg at one device pixel per
// CSS pixel. Electron 37 on Windows decodes the equivalent SVG data URL to an
// empty NativeImage, so the production boundary uses its 18x18 PNG raster.
const workbenchTrayIconPngBase64 = [
  "iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAACcElEQVR4nHxUO4gTURS9k3lvZmKCmw1idl2JCEIQ7GwESWGh",
  "hBQ2W1kFNVvsxkYb0UYbK9FFJBaazkZklfVDGhsrq6CVRWBtLGQh6yKyaGbezzvvZSaTSdyB4f3uPffcL4HEd7q3W3YVa1FL",
  "1G3JKlQJShUDogRQyYCCYETxPu67tiXbT6vV75GuFW3OfBk0HSGeEMVQmaMyB73K0Zo8Q3gWzFF87f65WicGqva2m7biz2Yq",
  "pgFS71SKlbsXljvW2d6PclaxLSo51S5oVyJh45K5T4HL6MwYZPgJkhd/W2Es/uvKjPuYjbmnhPNWJiuDuicD8KQPelU+DD59",
  "hBe18/DmymUQO9uQ2fsN727fgUcXL8HnjU3IqsDIavkAz6xOXOlXkta1ZXTHBFABvuOvwFJS34UyrvDTTCsEUSkB43MEhtmI",
  "gTwEdRWADQYIw6BZmxjFMaXIaJiIhUALbMxIKXDw3ZNS7yNG3jQjCBlNBddRSdeYdi1ipIGkPzaMsnr10OJEetFCsZCDbP4A",
  "DPf+wPDnAHLzOfi1s6uByosFHbd0GRBXBWGFUkPRWDh6pAhLxxZh6+s3eHjrcdxCpVIBTh4/pLOWKhOWQX/7YRZMdoY6I3OO",
  "gqvXluFwaT4Gyec8uLFag4WDBGWGRjbUMfs+QaAuNuOp2NfRmp/z4MH66oxeC2a1SpfY3G97Nr8eVmictWQWE91PQCRaI647",
  "ZinW1k37/O36uGn3aY3p+9AQX1lqbHTiMfJq816TCjYaI4m0mjk0C5BRkGsLjdediXkUfh9e3izbSrYcHGwIUNEVO8FEMNz3",
  "EbTrWkG72HgfD7Z/AAAA//8s1qitAAAABklEQVQDACiMN5UrqcmkAAAAAElFTkSuQmCC",
].join("");

export const workbenchTrayIconDataUrl =
  `data:image/png;base64,${workbenchTrayIconPngBase64}`;

export interface WorkbenchNativeImage {
  isEmpty(): boolean;
}

export function createWorkbenchTrayIcon<T extends WorkbenchNativeImage>(
  nativeImageFactory: {
    readonly createFromDataURL: (dataUrl: string) => T;
  },
): T {
  const icon = nativeImageFactory.createFromDataURL(workbenchTrayIconDataUrl);
  if (icon.isEmpty()) throw new Error("workbench-tray-icon-unavailable");
  return icon;
}
