// icloud_state [--evict] PATH...
// Prints "<uploaded 0/1> <uploading 0/1> <downloaded-status> <size> <path>" for each regular file
// under PATH (recursive). With --evict, evicts local copies of files already uploaded.
import Foundation
var args = Array(CommandLine.arguments.dropFirst())
let evict = args.first == "--evict"
if evict { args.removeFirst() }
let fm = FileManager.default
let keys: [URLResourceKey] = [.ubiquitousItemIsUploadedKey, .ubiquitousItemIsUploadingKey,
  .ubiquitousItemDownloadingStatusKey, .fileSizeKey, .isRegularFileKey, .ubiquitousItemUploadingErrorKey]
var total = 0, up = 0, evicted = 0, notUp = 0
var upBytes: Int64 = 0, pendBytes: Int64 = 0
func handle(_ u: URL) {
  guard let v = try? u.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { return }
  total += 1
  let sz = Int64(v.fileSize ?? 0)
  let isUp = v.ubiquitousItemIsUploaded ?? false
  if isUp { up += 1; upBytes += sz } else { notUp += 1; pendBytes += sz }
  if let e = v.ubiquitousItemUploadingError { FileHandle.standardError.write("uploadError \(u.path): \(e)\n".data(using: .utf8)!) }
  let st = v.ubiquitousItemDownloadingStatus?.rawValue ?? "-"
  if evict && isUp && st == URLUbiquitousItemDownloadingStatus.current.rawValue {
    do { try fm.evictUbiquitousItem(at: u); evicted += 1 } catch { FileHandle.standardError.write("evictError \(u.path): \(error)\n".data(using: .utf8)!) }
  }
  if ProcessInfo.processInfo.environment["ICLOUD_VERBOSE"] != nil {
    print("\(isUp ? 1:0) \((v.ubiquitousItemIsUploading ?? false) ? 1:0) \(st) \(sz) \(u.path)")
  }
}
for p in args {
  let root = URL(fileURLWithPath: p)
  var isDir: ObjCBool = false
  guard fm.fileExists(atPath: p, isDirectory: &isDir) else { continue }
  if !isDir.boolValue { handle(root); continue }
  if let en = fm.enumerator(at: root, includingPropertiesForKeys: keys) {
    for case let u as URL in en { handle(u) }
  }
}
print("{\"files\":\(total),\"uploaded\":\(up),\"pending\":\(notUp),\"uploaded_bytes\":\(upBytes),\"pending_bytes\":\(pendBytes),\"evicted\":\(evicted)}")
