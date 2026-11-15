// A Prism nyelvi komponensek a globális `Prism` objektumra épülnek → előbb ezt kell betölteni.
import Prism from 'prismjs';

Prism.manual = true; // ne színezzen magától az oldalon (a renderelt nézetet a szerver highlight.js-szel színezi)
window.Prism = Prism;
export default Prism;
