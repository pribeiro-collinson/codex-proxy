import re
from pathlib import Path

# Patch 1: Update import
server = Path("src/server.ts")
content = server.read_text()
content = content.replace(
    'import { listSlugs, routeModel } from "./router.ts";',
    'import { listSlugs, routeModel, routeModelMultimodal } from "./router.ts";'
)

# Patch 2: Replace routeModel calls with routeModelMultimodal
content = re.sub(
    r'const provider = routeModel\(parsed\.model, config\);',
    'const provider = routeModelMultimodal(parsed.model, config, process.env, parsed.messages);',
    content
)

server.write_text(content)
print("✅ Patched server.ts")
