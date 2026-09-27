import React from "react";
import * as ReactDOM from "react-dom";

export function ModalViaAliasedNamespace(props: { message: string }) {
  return ReactDOM.createPortal(<div className="modal">{props.message}</div>, document.body);
}
