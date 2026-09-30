'use strict';
/* Scripts run inside a claude.ai page, only when the user presses a button. */

/**
 * Puts text in the chat box without sending it. Tries a synthetic paste (what rich editors such
 * as ProseMirror handle best), then execCommand. Resolves to "ok", "noel" or "fail".
 */
function insert(text) {
  return `(function(t){
    function vis(e){return !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);}
    function find(){var s=['div.ProseMirror[contenteditable="true"]','[contenteditable="true"][role="textbox"]','div[contenteditable="true"]','textarea'];
      for(var i=0;i<s.length;i++){var l=document.querySelectorAll(s[i]);for(var j=l.length-1;j>=0;j--){if(vis(l[j]))return l[j];}}return null;}
    var el=find(); if(!el) return 'noel'; el.focus();
    if(el.tagName==='TEXTAREA'){var d=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
      d.set.call(el,(el.value?el.value+'\\n':'')+t); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';}
    var before=(el.innerText||'').length, handled=false;
    try{var dt=new DataTransfer(); dt.setData('text/plain',t);
      handled=!el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}catch(e){}
    if(handled||(el.innerText||'').length>before) return 'ok';
    try{if(document.execCommand('insertText',false,t)) return 'ok';}catch(e){}
    return 'fail';
  })(${JSON.stringify(text)})`;
}

const PAGE_TEXT = `(function(){try{return document.body?document.body.innerText:'';}catch(e){return '';}})()`;

module.exports = { insert, PAGE_TEXT };
