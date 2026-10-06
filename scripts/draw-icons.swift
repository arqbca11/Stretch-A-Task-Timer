// Draws Stretch's icons: two parallel blocks of different lengths, each solid up to "now" and
// translucent (or outlined, in the menu bar) above it, as on the app's timeline.
//
// Regenerate (from the repo root):
//   swift scripts/draw-icons.swift tray 18 src-tauri/icons/trayTemplate.png
//   swift scripts/draw-icons.swift tray 36 src-tauri/icons/trayTemplate@2x.png
//   swift scripts/draw-icons.swift app 1024 src-tauri/icons/app-icon.png
//   npx tauri icon src-tauri/icons/app-icon.png -o <tmp>   # then copy 32x32, 128x128,
//                                                          # 128x128@2x, icon.png, icon.icns
// usage: swift draw-icons.swift <tray|app> <size> <out.png>
import AppKit

let args = CommandLine.arguments
let kind = args[1], size = CGFloat(Double(args[2])!), out = args[3]
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setShouldAntialias(true)

// Blocks in a unit square (y up): (left, width, height); both start at the bottom.
let shapes: [(CGFloat, CGFloat, CGFloat)] = [(0.0, 0.44, 0.60), (0.56, 0.44, 1.0)]
let now: CGFloat = 0.40   // how far up "now" is: below it the blocks are solid

func rect(_ s: (CGFloat, CGFloat, CGFloat), _ box: CGRect, top: CGFloat? = nil) -> CGRect {
  CGRect(x: box.minX + s.0 * box.width, y: box.minY, width: s.1 * box.width, height: (top ?? s.2) * box.height)
}

if kind == "tray" {
  // Template image: black on transparent; macOS tints it for the menu bar.
  let pad = size * 0.08
  let box = CGRect(x: pad, y: pad, width: size - 2 * pad, height: size - 2 * pad)
  let line = max(1.0, size * 0.085), r = size * 0.09
  ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
  ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
  ctx.setLineWidth(line)
  for s in shapes {
    let full = rect(s, box).insetBy(dx: line / 2, dy: line / 2)
    ctx.addPath(CGPath(roundedRect: full, cornerWidth: r, cornerHeight: r, transform: nil)); ctx.strokePath()
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: rect(s, box), cornerWidth: r, cornerHeight: r, transform: nil)); ctx.clip()
    ctx.fill(rect(s, box, top: now))
    ctx.restoreGState()
  }
} else {
  // App icon: black rounded square (macOS grid: 824 of 1024), the past in grey below the now
  // dot on a thin axis, and a teal and a pink block.
  let s = size / 1024
  let black = CGColor(red: 0, green: 0, blue: 0, alpha: 1)
  let tile = CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
  let clip = CGPath(roundedRect: tile, cornerWidth: 185 * s, cornerHeight: 185 * s, transform: nil)
  ctx.addPath(clip); ctx.setFillColor(black); ctx.fillPath()
  let box = CGRect(x: 360 * s, y: 250 * s, width: 440 * s, height: 520 * s)
  let nowY = box.minY + now * box.height
  ctx.saveGState(); ctx.addPath(clip); ctx.clip()
  ctx.setFillColor(CGColor(red: 0.13, green: 0.13, blue: 0.13, alpha: 1))
  ctx.fill(CGRect(x: 300 * s, y: 100 * s, width: 624 * s, height: nowY - 100 * s))
  ctx.restoreGState()
  let axisX = 290 * s
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.9))
  ctx.fill(CGRect(x: axisX - 4 * s, y: 200 * s, width: 8 * s, height: 624 * s))
  ctx.fillEllipse(in: CGRect(x: axisX - 26 * s, y: nowY - 26 * s, width: 52 * s, height: 52 * s))
  let colors: [(CGFloat, CGFloat, CGFloat)] = [(0, 194, 206), (255, 61, 139)]
  for (i, sh) in shapes.enumerated() {
    let c = colors[i], r = 26 * s
    let full = CGPath(roundedRect: rect(sh, box), cornerWidth: r, cornerHeight: r, transform: nil)
    ctx.saveGState(); ctx.addPath(full); ctx.clip()
    ctx.setFillColor(CGColor(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, alpha: 0.38))
    ctx.fill(rect(sh, box))
    ctx.setFillColor(CGColor(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, alpha: 1))
    ctx.fill(rect(sh, box, top: now))
    ctx.restoreGState()
  }
}

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
