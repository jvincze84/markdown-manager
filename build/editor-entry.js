// Böngészős bundle a Toast UI Editorhoz (prosemirror függőségekkel együtt) + kódszínezés (Prism)
import Prism from './prism-setup.js';
// Nyelvek – a függőségi sorrend számít (pl. cpp → c, tsx → jsx + typescript, php → markup-templating)
import 'prismjs/components/prism-markup-templating.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-shell-session.js';
import 'prismjs/components/prism-powershell.js';
import 'prismjs/components/prism-batch.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-json5.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-ini.js';
import 'prismjs/components/prism-properties.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-plsql.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-java.js';
import 'prismjs/components/prism-kotlin.js';
import 'prismjs/components/prism-groovy.js';
import 'prismjs/components/prism-scala.js';
import 'prismjs/components/prism-c.js';
import 'prismjs/components/prism-cpp.js';
import 'prismjs/components/prism-csharp.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-php.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-perl.js';
import 'prismjs/components/prism-lua.js';
import 'prismjs/components/prism-swift.js';
import 'prismjs/components/prism-docker.js';
import 'prismjs/components/prism-nginx.js';
import 'prismjs/components/prism-apacheconf.js';
import 'prismjs/components/prism-hcl.js';
import 'prismjs/components/prism-makefile.js';
import 'prismjs/components/prism-diff.js';
import 'prismjs/components/prism-git.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-graphql.js';
import 'prismjs/components/prism-regex.js';
import 'prismjs/components/prism-csv.js';
import 'prismjs/components/prism-log.js';
import 'prismjs/components/prism-scss.js';
import 'prismjs/components/prism-protobuf.js';
import Editor from '@toast-ui/editor';
import codeSyntaxHighlight from '@toast-ui/editor-plugin-code-syntax-highlight';

// Közös bővítések (aliasok, bash parancsfelismerés) – ugyanaz, mint a szerveren
import extendPrism from '../lib/prism-extend.js';

extendPrism(Prism);

window.toastui = { Editor, plugins: { codeSyntaxHighlight }, Prism };
