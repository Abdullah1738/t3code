import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";

export function PauseBanner(props: { label: string; onLift: () => void; canLift: boolean }) {
  return (
    <div className="me-5 mb-3 flex items-center gap-2 rounded-xl bg-(--m-warnband) ps-3.5 pe-1.5 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate text-start font-medium">{props.label}</span>
      {props.canLift ? (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Pause actions"
                className="grid size-7 shrink-0 place-items-center rounded-full text-(--m-muted) outline-none hover:bg-(--m-active) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
              />
            }
          >
            <span aria-hidden>···</span>
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            <MenuItem onClick={props.onLift}>Lift pause</MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
