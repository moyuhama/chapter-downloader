import AppKit
import CoreServices

let bundle = Bundle.main.bundleURL
func resourceDirectory(_ app: URL) -> URL {
    let base=app.appendingPathComponent("Contents/Resources")
    if FileManager.default.isExecutableFile(atPath:base.appendingPathComponent("node").path) {return base}
    #if arch(arm64)
    return base.appendingPathComponent("arm64")
    #else
    return base.appendingPathComponent("x64")
    #endif
}
let resources = resourceDirectory(bundle)
let node = resources.appendingPathComponent("node")
let cli = resources.appendingPathComponent("app/launcher/cli.mjs")
func validStartURL(_ url: URL) -> Bool {
    return url.scheme?.lowercased() == "shiye" && url.host?.lowercased() == "start" && url.query == nil && url.fragment == nil && url.user == nil && url.password == nil && url.port == nil && (url.path.isEmpty || url.path == "/")
}
if let index=CommandLine.arguments.firstIndex(of:"--validate-url"), index+1<CommandLine.arguments.count {
    exit(URL(string:CommandLine.arguments[index+1]).map(validStartURL) == true ? 0 : 1)
}
if CommandLine.arguments.contains("--check") {
    let result: [String:Any] = ["node":FileManager.default.isExecutableFile(atPath:node.path), "cli":FileManager.default.fileExists(atPath:cli.path), "scheme":"shiye"]
    let data = try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
    print(String(data:data,encoding:.utf8)!)
    exit(result["node"] as! Bool && result["cli"] as! Bool ? 0 : 1)
}
class Delegate: NSObject, NSApplicationDelegate {
    var started = false
    var urlLaunch = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline:.now()+0.3) {if !self.urlLaunch {self.start()}}
    }
    func application(_ application:NSApplication, open urls:[URL]) {
        // Only a fixed action is accepted. URLs never become shell commands.
        urlLaunch=true
        guard urls.contains(where:validStartURL) else {NSApp.terminate(nil);return}
        start()
    }
    func start() {
        if started {return};started=true
        DispatchQueue.global().async {
            do {
                let fm=FileManager.default
                let folder=fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications",isDirectory:true)
                let installed=folder.appendingPathComponent("拾页助手.app",isDirectory:true)
                try fm.createDirectory(at:folder,withIntermediateDirectories:true)
                if bundle.standardizedFileURL != installed.standardizedFileURL {
                    if fm.fileExists(atPath:installed.path) {
                        // Only replace our own app bundle, and keep a recoverable previous build.
                        guard Bundle(url:installed)?.bundleIdentifier == "com.moyuhama.shiye.helper" else {throw NSError(domain:"Shiye",code:1,userInfo:[NSLocalizedDescriptionKey:"目标位置已有其他应用，请先选择其他安装位置"])}
                        let backup=folder.appendingPathComponent("拾页助手.previous.app")
                        if fm.fileExists(atPath:backup.path) {try fm.removeItem(at:backup)}
                        try fm.moveItem(at:installed,to:backup)
                        do {try fm.copyItem(at:bundle,to:installed)} catch {try? fm.moveItem(at:backup,to:installed);throw error}
                    } else {try fm.copyItem(at:bundle,to:installed)}
                }
                let status=LSRegisterURL(installed as CFURL,true)
                if status != noErr {throw NSError(domain:"Shiye",code:Int(status),userInfo:[NSLocalizedDescriptionKey:"无法注册 shiye 启动协议"])}
                let r=resourceDirectory(installed)
                let process=Process();process.executableURL=r.appendingPathComponent("node");process.arguments=[r.appendingPathComponent("app/launcher/cli.mjs").path,"start"]
                let pipe=Pipe();process.standardOutput=pipe;process.standardError=pipe
                try process.run();let output=pipe.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit()
                if process.terminationStatus != 0 {throw NSError(domain:"Shiye",code:2,userInfo:[NSLocalizedDescriptionKey:String(data:output,encoding:.utf8) ?? "服务启动失败"])}
                DispatchQueue.main.async {NSApp.terminate(nil)}
            } catch {
                DispatchQueue.main.async {let alert=NSAlert();alert.messageText="拾页助手启动失败";alert.informativeText=error.localizedDescription;alert.runModal();NSApp.terminate(nil)}
            }
        }
    }
}
let app=NSApplication.shared
let delegate=Delegate();app.delegate=delegate
app.setActivationPolicy(.accessory)
app.run()
