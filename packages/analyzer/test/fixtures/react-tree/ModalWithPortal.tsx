import React from "react";
import { createPortal } from "react-dom";

export function ModalWithPortal(props: { message: string }) {
  return createPortal(<div className="modal">{props.message}</div>, document.body);
}
