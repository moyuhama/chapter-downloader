#!/bin/zsh
# 可放在任意目录；仅通过本机接口停止拾页，不依赖 Node.js 或源码。
finish() {
  local result=$1
  if [[ -t 0 && "${SHIYE_STOP_NO_PAUSE:-0}" != 1 ]]; then
    read -k 1 "?按任意键退出…"
    printf '\n'
  fi
  exit "$result"
}
stop_port=${PORT:-3789}
if [[ ! "$stop_port" =~ '^[0-9]{1,5}$' ]] || (( 10#$stop_port < 1 || 10#$stop_port > 65535 )); then
  printf '%s\n' '端口无效，未停止任何服务。'
  finish 1
fi
stop_base="http://127.0.0.1:${stop_port}"
stop_file=$(/usr/bin/mktemp "${TMPDIR:-/tmp}/shiye-stop.XXXXXX") || finish 1
trap '/bin/rm -f -- "$stop_file"' EXIT
get_health() {
  /usr/bin/curl --noproxy '*' --silent --show-error --fail --connect-timeout 1 --max-time 2 --max-filesize 65536 \
    "${stop_base}/api/health" --output "$stop_file" 2>/dev/null
}
field() { /usr/bin/plutil -extract "$1" raw -o - "$stop_file" 2>/dev/null; }
get_health
stop_probe=$?
if (( stop_probe == 7 )); then
  printf '%s\n' '拾页服务未运行，或已经停止。'
  finish 0
elif (( stop_probe != 0 )); then
  printf '%s\n' '无法确认拾页服务状态，未发送停止请求，请稍后重试。'
  finish 1
fi
stop_app=$(field app)
stop_instance=$(field instanceId)
stop_capability=$(field capabilities.shutdown)
if [[ "$stop_app" != chapter-downloader ]]; then
  printf '%s\n' '此端口不是拾页服务，未停止任何程序。'
  finish 1
fi
if [[ "$stop_capability" != true || ! "$stop_instance" =~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' ]]; then
  printf '%s\n' '助手版本不支持安全停止，请在原终端按 Ctrl+C，或更新助手。'
  finish 1
fi
printf '%s\n' '正在保存进度并停止拾页服务，请稍候…'
stop_http=$(/usr/bin/curl --noproxy '*' --silent --show-error --connect-timeout 1 --max-time 5 \
  --output "$stop_file" --write-out '%{http_code}' --header 'Content-Type: application/json' \
  --data "{\"instanceId\":\"${stop_instance}\"}" "${stop_base}/api/service/stop")
if (( $? != 0 )) || [[ "$stop_http" != 200 ]]; then
  printf '%s\n' '停止请求失败或服务实例已变化，请重新运行；未强制结束任何进程。'
  finish 1
fi
stop_deadline=$((SECONDS + 40))
while (( SECONDS < stop_deadline )); do
  get_health
  stop_probe=$?
  if (( stop_probe == 7 )); then
    printf '%s\n' '拾页服务已停止。已下载的文件保留。'
    finish 0
  elif (( stop_probe == 0 )); then
    if [[ "$(field app)" != chapter-downloader || "$(field instanceId)" != "$stop_instance" ]]; then
      printf '%s\n' '原服务已退出，但端口上出现了新服务；未停止新服务，请核对后重新运行。'
      finish 1
    fi
  fi
  /bin/sleep 0.25
done
printf '%s\n' '停止请求已发送，但服务仍在收尾，请稍后再检查。'
finish 1
