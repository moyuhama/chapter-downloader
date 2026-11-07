#!/bin/zsh
cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 20 或更高版本。"
  read -k 1 "?按任意键退出"
  exit 1
fi
if [[ ! -d node_modules/playwright ]]; then
  npm install || exit 1
  npm run setup || exit 1
fi
(sleep 2; open http://127.0.0.1:3789) &
npm start
