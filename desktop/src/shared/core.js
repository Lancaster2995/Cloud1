/*
 * Relevo core: status-block parser, prompts and small data helpers.
 * Same formats as the Android app (StateBlock.java / Prompts.java / Data.java), so projects
 * exported as JSON move between devices. Works in Node (require) and in the renderer (<script>).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelevoCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const START = '<<<ESTADO';
  const END = 'ESTADO>>>';
  const PLACEHOLDER = '<número 0-100>';
  const KEYS = ['PROYECTO', 'PROGRESO', 'RESUMEN', 'HECHO', 'EN_PROGRESO', 'SIGUIENTES_PASOS',
    'DECISIONES', 'BLOQUEOS', 'ARCHIVOS_CLAVE', 'CONTEXTO_EXTRA'];
  const KEY_LINE = /^\s*[*#>`\s]*([A-ZÁÉÍÓÚÑ_]{3,})[*`\s]*:\s*(.*)$/;

  const URL_CHAT = 'https://claude.ai/new';
  const URL_CODE = 'https://claude.ai/code';
  const COLORS = ['#D97757', '#4F7DF3', '#2DA44E', '#A259FF', '#E5A50A', '#E5484D', '#12A4B5', '#8B6E4E'];
  const MAX_HISTORY = 120;

  // ------------------------------------------------------------------ status block

  function rtrim(s) {
    return s.replace(/\s+$/, '');
  }

  function knownKeys(block) {
    const seen = new Set();
    for (const line of block.split('\n')) {
      const m = KEY_LINE.exec(line);
      if (m && KEYS.includes(m[1])) seen.add(m[1]);
    }
    return seen.size;
  }

  function isTemplate(block) {
    return block.includes(PLACEHOLDER) || block.includes('<tarea completada>');
  }

  /** Trims trailing spaces, drops stray code fences and collapses blank runs. */
  function normalize(block) {
    const out = [];
    let blank = 0;
    for (const raw of block.replace(/\r\n/g, '\n').split('\n')) {
      const line = rtrim(raw);
      if (line.trim().startsWith('```')) continue;
      if (line.trim() === '') {
        if (++blank > 1) continue;
      } else {
        blank = 0;
      }
      out.push(line);
    }
    return out.join('\n').trim();
  }

  /**
   * Newest status block in `text`. With requireEnd (page text that may still be streaming) a
   * block without its closing marker is ignored; otherwise (clipboard) it runs to the end.
   * Returns {block, newestIsTemplate}.
   */
  function find(text, requireEnd) {
    if (text == null) return { block: null, newestIsTemplate: false };
    const t = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let from = t.length;
    let newest = true;
    let newestTemplate = false;
    while (from > 0) {
      const start = t.lastIndexOf(START, from - 1);
      if (start < 0) break;
      const end = t.indexOf(END, start + START.length);
      let block = null;
      if (end >= 0) block = t.substring(start, end + END.length);
      else if (!requireEnd) block = t.substring(start).trim() + '\n' + END;
      if (block != null && knownKeys(block) >= 2) {
        if (isTemplate(block)) {
          if (newest) newestTemplate = true;
        } else {
          return { block: normalize(block), newestIsTemplate: newestTemplate };
        }
      }
      newest = false;
      from = start;
    }
    return { block: null, newestIsTemplate: newestTemplate };
  }

  /** Text of a section: inline value plus following lines up to the next known key. */
  function section(block, key) {
    if (block == null) return null;
    let acc = null;
    for (const line of block.split('\n')) {
      if (line.includes(START) || line.includes(END)) {
        if (acc != null) break;
        continue;
      }
      const m = KEY_LINE.exec(line);
      if (m && KEYS.includes(m[1])) {
        if (acc != null) break;
        if (m[1] === key) {
          acc = [];
          const inline = m[2].replace(/^[*_`\s]+|[*_`\s]+$/g, '');
          if (inline) acc.push(inline);
        }
        continue;
      }
      if (acc != null) acc.push(line);
    }
    return acc == null ? null : acc.join('\n').trim();
  }

  function items(block, key) {
    const s = section(block, key);
    if (!s) return [];
    const out = [];
    for (const line of s.split('\n')) {
      let l = line.trim();
      if (l.startsWith('- ') || l.startsWith('* ') || l.startsWith('• ')) l = l.substring(2).trim();
      else if (l === '-' || l === '*') continue;
      if (l) out.push(l);
    }
    return out;
  }

  /** PROGRESO clamped to 0..100, or -1 when missing. */
  function progress(block) {
    const v = section(block, 'PROGRESO');
    if (v == null) return -1;
    const m = /(\d{1,3})/.exec(v);
    if (!m) return -1;
    return Math.max(0, Math.min(100, parseInt(m[1], 10)));
  }

  // ------------------------------------------------------------------ prompts

  const empty = (s) => s == null || String(s).trim() === '';
  const hasState = (p) => !empty(p.state);

  function template(projectName) {
    return [
      START,
      'PROYECTO: ' + (empty(projectName) ? '<nombre>' : projectName),
      'PROGRESO: ' + PLACEHOLDER + '%',
      'RESUMEN: <1-3 frases: en qué punto está el proyecto>',
      'HECHO:',
      '- <tarea completada>',
      'EN_PROGRESO:',
      '- <tarea a medias y exactamente dónde quedó>',
      'SIGUIENTES_PASOS:',
      '- <paso concreto, en orden>',
      'DECISIONES:',
      '- <decisión técnica y su motivo>',
      'BLOQUEOS:',
      '- <problema pendiente, o "ninguno">',
      'ARCHIVOS_CLAVE:',
      '- <ruta o artefacto: para qué sirve>',
      'CONTEXTO_EXTRA:',
      '<comandos, versiones, URLs o datos imprescindibles para continuar; sin contraseñas ni claves>',
      END
    ].join('\n');
  }

  function repoLines(p, handoff) {
    if (empty(p.repo)) return '';
    let s = 'Repositorio: ' + p.repo.trim();
    if (!empty(p.branch)) s += ' (rama ' + p.branch.trim() + ')';
    s += '\n';
    if (handoff) s += 'Antes de seguir, revisa el repositorio y HANDOFF.md para confirmar el estado real del código.\n';
    return s;
  }

  function start(p) {
    let s = 'Vamos a desarrollar el proyecto «' + p.name + '».\n\n';
    if (!empty(p.goal)) s += 'Objetivo: ' + p.goal.trim() + '\n';
    s += repoLines(p, false);
    if (!empty(p.notes)) s += '\nContexto e indicaciones:\n' + p.notes.trim() + '\n';
    s += '\nEste trabajo se hará en varias sesiones y puede continuar en otra conversación. Por eso:\n';
    s += '1. Avanza por etapas y termina cada respuesta indicando qué quedó hecho y qué sigue.\n';
    s += '2. Cuando te escriba «CHECKPOINT», responde únicamente con el bloque de estado, dentro de un bloque de código, con este formato:\n\n';
    s += '```\n' + template(p.name) + '\n```\n';
    if (!empty(p.repo)) {
      s += '3. Haz commit y push de cada avance y mantén ese mismo bloque actualizado en HANDOFF.md, en la raíz del repositorio.\n';
    }
    s += '\nEmpecemos: propón un plan breve por etapas y comienza con la primera.';
    return s;
  }

  function handoff(p) {
    if (!hasState(p)) return start(p);
    let s = 'Continúo el proyecto «' + p.name + '», que se venía desarrollando en otra sesión. Este es su último estado registrado';
    if (p.stateTime > 0) s += ' (' + stamp(p.stateTime) + ')';
    s += ':\n\n```\n' + p.state.trim() + '\n```\n\n';
    if (!empty(p.goal)) s += 'Objetivo general: ' + p.goal.trim() + '\n';
    s += repoLines(p, true);
    if (!empty(p.notes)) s += '\nContexto e indicaciones:\n' + p.notes.trim() + '\n';
    s += '\nInstrucciones:\n';
    s += '- Retoma desde SIGUIENTES_PASOS sin rehacer lo que ya está HECHO.\n';
    s += '- Respeta las DECISIONES tomadas salvo que encuentres un problema; si es así, explícalo.\n';
    s += '- Si te falta información imprescindible, pregúntame antes de suponer.\n';
    s += '- Cuando te escriba «CHECKPOINT», responde solo con el bloque de estado actualizado, con el mismo formato que el de arriba y dentro de un bloque de código.\n';
    if (!empty(p.repo)) s += '- Haz commit y push de cada avance y mantén HANDOFF.md actualizado.\n';
    s += '\nPrimero confirma en 2-3 líneas lo que entiendes del estado y el siguiente paso; luego continúa.';
    return s;
  }

  function checkpoint(p) {
    const name = p ? p.name : '';
    let s = 'CHECKPOINT. Voy a continuar este proyecto en otra sesión. Responde ÚNICAMENTE con el estado actualizado, dentro de un bloque de código, usando exactamente este formato (sin texto antes ni después):\n\n';
    s += '```\n' + template(name) + '\n```\n';
    s += '\nSé concreto: el objetivo es que otra sesión sin memoria de esta conversación pueda continuar sin perder nada.';
    if (p && !empty(p.repo)) s += ' Antes de responder, haz commit y push de los cambios pendientes y guarda el bloque en HANDOFF.md.';
    return s;
  }

  const next = (p) => (hasState(p) ? handoff(p) : start(p));

  // ------------------------------------------------------------------ formatting

  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  function stamp(t) {
    const d = new Date(t);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function clock(t) {
    const d = new Date(t);
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return hm;
    if (d.toDateString() === tomorrow.toDateString()) return 'mañana ' + hm;
    return d.getDate() + '/' + (d.getMonth() + 1) + ' ' + hm;
  }

  function ago(t) {
    if (!t) return 'nunca';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'hace un momento';
    const m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    const h = Math.floor(m / 60);
    if (h < 24) return 'hace ' + h + ' h';
    const d = Math.floor(h / 24);
    return d === 1 ? 'hace 1 día' : 'hace ' + d + ' días';
  }

  function duration(ms) {
    const total = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(total / 60), m = total % 60;
    if (h === 0) return m + ' min';
    if (m === 0) return h + ' h';
    return h + ' h ' + m + ' min';
  }

  function accountName(data, slot) {
    const a = (data.accounts || []).find((x) => x.slot === slot);
    return a ? a.name : (slot > 0 ? 'Cuenta ' + slot : '—');
  }

  function describe(e) {
    const nameOr = (n, slot) => (empty(n) ? 'Cuenta ' + slot : n);
    let s = stamp(e.time) + ' · ';
    switch (e.type) {
      case 'create': s += 'Proyecto creado'; break;
      case 'transfer':
        s += e.slot === 0 ? 'Asignado a ' + nameOr(e.toAccountName, e.toSlot)
          : 'Traspaso ' + nameOr(e.accountName, e.slot) + ' → ' + nameOr(e.toAccountName, e.toSlot);
        break;
      case 'edit': s += 'Estado editado a mano'; break;
      case 'restore': s += 'Estado restaurado'; break;
      default: s += 'Checkpoint desde ' + nameOr(e.accountName, e.slot);
    }
    if (e.progress >= 0) s += ' · ' + e.progress + '%';
    return s;
  }

  function summary(p) {
    return hasState(p) ? (section(p.state, 'RESUMEN') || '') : '';
  }

  function nextStep(p) {
    if (!hasState(p)) return '';
    const steps = items(p.state, 'SIGUIENTES_PASOS');
    return steps.length ? steps[0] : '';
  }

  function markdown(p, data) {
    let s = '# ' + p.name + '\n\n';
    if (!empty(p.goal)) s += '**Objetivo:** ' + p.goal.trim() + '\n\n';
    if (!empty(p.repo)) {
      s += '**Repositorio:** ' + p.repo.trim();
      if (!empty(p.branch)) s += ' (rama ' + p.branch.trim() + ')';
      s += '\n\n';
    }
    s += '**Progreso:** ' + p.progress + '%  \n';
    s += '**Cuenta actual:** ' + accountName(data, p.currentSlot) + '\n\n';
    if (!empty(p.notes)) s += '## Indicaciones\n\n' + p.notes.trim() + '\n\n';
    s += '## Estado actual\n\n```\n' + (hasState(p) ? p.state.trim() : '(sin estado guardado todavía)') + '\n```\n\n## Historial\n\n';
    for (let i = (p.history || []).length - 1; i >= 0; i--) s += '- ' + describe(p.history[i]) + '\n';
    return s;
  }

  function isPaused(a, now) {
    return (a.pausedUntil || 0) > (now || Date.now());
  }

  function accountLabel(a, now) {
    now = now || Date.now();
    return isPaused(a, now) ? a.name + ' — en pausa (' + duration(a.pausedUntil - now) + ')' : a.name + ' — disponible';
  }

  return {
    START, END, PLACEHOLDER, KEYS, URL_CHAT, URL_CODE, COLORS, MAX_HISTORY,
    find, section, items, progress, normalize, isTemplate, knownKeys,
    template, start, handoff, checkpoint, next, hasState,
    stamp, clock, ago, duration, accountName, describe, summary, nextStep, markdown,
    isPaused, accountLabel
  };
});
