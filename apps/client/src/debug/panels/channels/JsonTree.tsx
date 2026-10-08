// Collapsible JSON view (objects/arrays fold; long containers are capped with
// "… N more"; tensors nested in JSON print as dtype[shape]).

import { useState } from 'preact/hooks';
import { isTensor } from '@evolspace/protocol';
import { fmtNum } from '../../ui/format.ts';
import { tensorLabel } from './tensor.ts';

const MAX_CHILDREN = 200;
const MAX_STR = 400;

function Scalar({ v }: { v: unknown }) {
  if (v === null) return <span class="nul">null</span>;
  if (typeof v === 'number') return <span class="num">{Number.isFinite(v) ? String(v) : fmtNum(v)}</span>;
  if (typeof v === 'boolean') return <span class="b">{String(v)}</span>;
  if (typeof v === 'string') return <span class="s" title={v.length > MAX_STR ? `${v.length} chars` : undefined}>{JSON.stringify(v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v)}</span>;
  if (isTensor(v)) return <span class="num">{`<${tensorLabel(v)}>`}</span>;
  if (v === undefined) return <span class="nul">undefined</span>;
  return <span>{String(v)}</span>;
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null && !isTensor(v) && !ArrayBuffer.isView(v);
}

/** Short summary of a folded container. */
export function summarize(v: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(v)) {
    if (v.length && v.length <= 6 && v.every((x) => typeof x === 'number')) return `[${(v as number[]).map((x) => fmtNum(x, 3)).join(', ')}]`;
    return `Array(${v.length})`;
  }
  const keys = Object.keys(v);
  const head = keys.slice(0, 4).join(', ');
  return `{${head}${keys.length > 4 ? `, …+${keys.length - 4}` : ''}}`;
}

function Node({ k, v, depth, open: open0, last }: { k?: string; v: unknown; depth: number; open: number; last: boolean }) {
  const [open, setOpen] = useState(depth < open0);
  const [all, setAll] = useState(false);
  const key = k !== undefined ? <><span class="k">{k}</span><span class="nul">{': '}</span></> : null;
  const comma = last ? '' : ',';
  const pad = { paddingLeft: `${depth * 14}px` };
  if (!isContainer(v)) {
    return <div class="ln" style={pad}><span class="sp" />{key}<Scalar v={v} />{comma}</div>;
  }
  const arr = Array.isArray(v);
  const entries: Array<[string, unknown]> = arr ? (v as unknown[]).map((x, i) => [String(i), x]) : Object.entries(v);
  const [o, c] = arr ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return <div class="ln" style={pad}><span class="sp" />{key}<span class="nul">{o}{c}</span>{comma}</div>;
  if (!open) {
    return (
      <div class="ln" style={pad}>
        <span class="tg" onClick={() => setOpen(true)}>▸</span>{key}
        <span class="sum" onClick={() => setOpen(true)}>{summarize(v)}</span>{comma}
      </div>
    );
  }
  const shown = all ? entries : entries.slice(0, MAX_CHILDREN);
  return (
    <>
      <div class="ln" style={pad}><span class="tg" onClick={() => setOpen(false)}>▾</span>{key}<span class="nul">{o}</span>{arr ? <span class="nul">&nbsp;{entries.length} items</span> : null}</div>
      {shown.map(([ck, cv], i) => <Node key={ck} k={arr ? undefined : ck} v={cv} depth={depth + 1} open={open0} last={i === entries.length - 1} />)}
      {shown.length < entries.length ? (
        <div class="ln" style={{ paddingLeft: `${(depth + 1) * 14}px` }}><span class="sp" />
          <span class="more sum" onClick={() => setAll(true)}>… {entries.length - shown.length} more (show all)</span>
        </div>
      ) : null}
      <div class="ln" style={pad}><span class="sp" /><span class="nul">{c}</span>{comma}</div>
    </>
  );
}

/** `open` = depth to which containers start expanded. */
export function JsonTree({ value, open = 2 }: { value: unknown; open?: number }) {
  return <div class="dbg-jt"><Node v={value} depth={0} open={open} last /></div>;
}
