'use strict';
(async()=>{
  const pane=document.querySelector('#visitor-cards');
  const element=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node};
  try{
    const slug=location.pathname.split('/').at(-1);
    const response=await fetch('/api/trust-center-visitor/'+encodeURIComponent(slug),{credentials:'omit'});
    if(!response.ok)throw Error('Unavailable');
    const data=await response.json();
    const cards=data.cards.map(card=>{
      const section=document.createElement('section');
      section.append(element('h2',card.heading),element('p',card.description));
      return section;
    });
    pane.replaceChildren(...(cards.length?cards:[element('p','No published cards yet.')]));
  }catch{pane.replaceChildren(element('p','This local visitor preview could not be loaded.'))}
})();
