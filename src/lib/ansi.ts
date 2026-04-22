// Minimal ANSI SGR -> HTML converter for the subset colorama emits. Maps
// ANSI color codes to our palette so AP log lines keep their semantic colors.

const ANSI_COLORS = {
  30:"#3e3c36", 31:"#d97757", 32:"#8fc4b0", 33:"#c9a86a",
  34:"#7ba2c4", 35:"#d49bc9", 36:"#5a9c89", 37:"#ebe3cf",
  90:"#6b6657", 91:"#e2896d", 92:"#a4d3c2", 93:"#d7b87e",
  94:"#92b4cd", 95:"#deabd1", 96:"#70ad99", 97:"#f4ecd8",
};

export function escHtml(s) {
  return s.replace(/[&<>]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" })[c]);
}

export function ansiToHtml(s) {
  const out = [];
  const re = /\x1b\[([\d;]*)m/g;
  let cur = null, last = 0, m;
  const flush = (end) => {
    if (end <= last) return;
    const chunk = escHtml(s.slice(last, end));
    out.push(cur ? `<span style="color:${cur}">${chunk}</span>` : chunk);
  };
  while ((m = re.exec(s)) !== null) {
    flush(m.index);
    const codes = m[1].split(";").filter(c => c.length).map(Number);
    if (codes.length === 0 || codes.includes(0)) cur = null;
    for (const c of codes) if (c in ANSI_COLORS) cur = ANSI_COLORS[c];
    last = m.index + m[0].length;
  }
  flush(s.length);
  return out.join("");
}
