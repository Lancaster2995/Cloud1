package io.github.lancaster2995.relevo;

import org.json.JSONObject;
import org.json.JSONTokener;

/** JavaScript snippets evaluated in a session page, only when the user taps a button. */
final class Js {

    private Js() {
    }

    /**
     * Puts {@code text} into the chat box without sending it. Tries a synthetic paste first (what
     * rich editors such as ProseMirror handle best), then execCommand, and reports "ok",
     * "noel" (no chat box on this page) or "fail".
     */
    static String insert(String text) {
        return "(function(t){"
                + "function vis(e){return !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);}"
                + "function find(){var s=['div.ProseMirror[contenteditable=\"true\"]',"
                + "'[contenteditable=\"true\"][role=\"textbox\"]','div[contenteditable=\"true\"]','textarea'];"
                + "for(var i=0;i<s.length;i++){var l=document.querySelectorAll(s[i]);"
                + "for(var j=l.length-1;j>=0;j--){if(vis(l[j]))return l[j];}}return null;}"
                + "var el=find();if(!el)return 'noel';el.focus();"
                + "if(el.tagName==='TEXTAREA'){var d=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');"
                + "d.set.call(el,(el.value?el.value+'\\n':'')+t);el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok';}"
                + "var before=(el.innerText||'').length,handled=false;"
                // A handled paste is cancelled by the editor (it may also turn long text into an attachment).
                + "try{var dt=new DataTransfer();dt.setData('text/plain',t);"
                + "handled=!el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}catch(e){}"
                + "if(handled||(el.innerText||'').length>before)return 'ok';"
                + "try{if(document.execCommand('insertText',false,t))return 'ok';}catch(e){}"
                + "return 'fail';"
                + "})(" + JSONObject.quote(text) + ")";
    }

    static final String PAGE_TEXT =
            "(function(){try{return document.body?document.body.innerText:'';}catch(e){return '';}})()";

    /** Fetches a blob:/data: download and hands it to the native bridge as a data URL. */
    static String fetchBlob(String url, String mime, String fileName) {
        return "(function(u,m,n){fetch(u).then(function(r){return r.blob();}).then(function(b){"
                + "var fr=new FileReader();fr.onloadend=function(){RelevoBridge.saveDataUrl(String(fr.result),m||b.type||'',n);};"
                + "fr.readAsDataURL(b);}).catch(function(e){RelevoBridge.downloadFailed(String(e));});})("
                + JSONObject.quote(url) + "," + JSONObject.quote(mime == null ? "" : mime) + ","
                + JSONObject.quote(fileName) + ")";
    }

    /** Decodes the JSON value handed back by evaluateJavascript into a plain string. */
    static String decode(String jsonValue) {
        if (jsonValue == null || "null".equals(jsonValue)) return "";
        try {
            Object v = new JSONTokener(jsonValue).nextValue();
            return v instanceof String ? (String) v : String.valueOf(v);
        } catch (Exception e) {
            return "";
        }
    }
}
