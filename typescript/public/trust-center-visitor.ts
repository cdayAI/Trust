'use strict';
(async()=>{
  const pane=document.querySelector<HTMLElement>('#visitor-cards');
  if(!pane)throw Error('Visitor cards region missing.');
  const element=<K extends keyof HTMLElementTagNameMap>(tag:K,value:string):HTMLElementTagNameMap[K]=>{
    const node=document.createElement(tag);node.textContent=value;return node;
  };
  function isRecord(value:unknown):value is Record<string,unknown>{
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
  }
  try{
    const slug=location.pathname.split('/').at(-1);
    if(slug===undefined)throw Error('Unavailable');
    const response=await fetch('/api/trust-center-visitor/'+encodeURIComponent(slug),{credentials:'omit'});
    if(!response.ok)throw Error('Unavailable');
    const data:unknown=await response.json();
    if(!isRecord(data)||!Array.isArray(data.cards))throw Error('Invalid visitor response');
    const cards=data.cards.map((card:unknown)=>{
      if(!isRecord(card)||typeof card.heading!=='string'||typeof card.description!=='string')throw Error('Invalid visitor card');
      const section=document.createElement('section');
      section.append(element('h2',card.heading),element('p',card.description));
      return section;
    });
    pane.replaceChildren(...(cards.length?cards:[element('p','No published cards yet.')]));
  }catch{pane.replaceChildren(element('p','This local visitor preview could not be loaded.'))}
})();
