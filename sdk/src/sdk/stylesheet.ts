// The package build's entry for the SDK stylesheet (T-3579): a lib build only emits the CSS its
// entries import, so without this one `style.css` held the components' rules and none of these.
import "./style.css";
