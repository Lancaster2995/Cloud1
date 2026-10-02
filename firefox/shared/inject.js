/*
 * Scripts run inside a claude.ai page, only when the user presses a button.
 * Works in Node (require) and in the Firefox extension (<script>).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelevoInject = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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

  /**
   * The conversation on a claude.ai page as "Yo:" / "Claude:" turns. If the page does not mark
   * its messages as expected, the text of the page without its side panels.
   */
  /** Text of the page without its side panels (the list of chats). */
  const MAIN_TEXT = `(function(){try{
    var root=document.querySelector('main')||document.body, t=root.innerText||'';
    [].forEach.call(root.querySelectorAll('nav,aside'),function(n){if(n.innerText)t=t.split(n.innerText).join('');});
    return t.trim();
  }catch(e){return '';}})()`;

  const CONVERSATION = `(function(){try{
    var U='[data-testid="user-message"]', all=[].slice.call(document.querySelectorAll(U+',.font-claude-response,.font-claude-message'));
    all=all.filter(function(e){return !all.some(function(o){return o!==e&&o.contains(e);});});
    if(all.length>1&&all.some(function(e){return e.matches(U);}))
      return all.map(function(e){return (e.matches(U)?'Yo: ':'Claude: ')+(e.innerText||'').trim();}).join('\\n\\n');
  }catch(e){}return ${MAIN_TEXT};})()`;

  return { insert, PAGE_TEXT, MAIN_TEXT, CONVERSATION };
});
