// Drag-and-drop or click-to-upload file input. Shared by the YAML step
// and ROM step.
export function Dropzone(props) {
  let zoneRef;
  const onDrag   = ev => { ev.preventDefault(); zoneRef?.classList.add("drag-over"); };
  const onLeave  = () => zoneRef?.classList.remove("drag-over");
  const onDrop   = ev => {
    ev.preventDefault();
    zoneRef?.classList.remove("drag-over");
    const f = ev.dataTransfer?.files?.[0];
    if (f) props.onFile(f);
  };
  const onChange = ev => {
    const f = ev.target.files?.[0];
    if (f) props.onFile(f);
  };
  return (
    <label
      class="dropzone"
      id={props.id}
      for={props.inputId}
      ref={zoneRef}
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={onLeave}
      onDrop={onDrop}
    >
      <input type="file" accept={props.accept} id={props.inputId} onChange={onChange} />
      {props.children}
    </label>
  );
}
