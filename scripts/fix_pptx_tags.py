from pathlib import Path
import re

p = Path(__file__).resolve().parents[1] / "src-tauri" / "src" / "pptx.rs"
t = p.read_text(encoding="utf-8")

helper = """
fn tag_is(n: Node<'_, '_>, local: &str) -> bool {
    n.tag_name().name() == local
}

fn attr_local<'a>(n: Node<'a, '_>, local: &str) -> Option<&'a str> {
    n.attributes().find(|a| a.name() == local).map(|a| a.value())
}

"""

if "fn tag_is" not in t:
    anchor = "use std::io::Read;\n"
    if anchor not in t:
        raise SystemExit("NO ANCHOR")
    t = t.replace(anchor, anchor + "\n" + helper, 1)

t = re.sub(
    r'\.has_tag_name\("(?:p|a):(\w+)"\)',
    r'.tag_name().name() == "\1"',
    t,
)
t = re.sub(r'(\w+)\.attribute\("r:embed"\)', r'attr_local(\1, "embed")', t)
t = re.sub(r'(\w+)\.attribute\("r:id"\)', r'attr_local(\1, "id")', t)

p.write_text(t, encoding="utf-8")
print("ok", t.count('tag_name().name()'), t.count("attr_local"))
