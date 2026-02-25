import { Menu } from 'lucide-react';
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from '~/components/ui/dropdown-menu';
import { Button } from '~/components/ui/button';

interface SystemData {
	name: string;
	cores: CoreData[];
}

interface CoreData {
	name: string;
	path: string;
}

const systems: SystemData[] = [
	{
		name: 'Nintendo (NES)',
		cores: [
			{
				name: 'Nestopia',
				path: '/retroarch/cores/nestopia_libretro_libnx.nro',
			},
		],
	},
	{
		name: 'Super Nintendo (SNES)',
		cores: [
			{
				name: 'Snes9x',
				path: '/retroarch/cores/snes9x_libretro_libnx.nro',
			},
			//{
			//	name: 'Snes9x (2010)',
			//	path: '/retroarch/cores/snes9x2010_libretro_libnx.nro',
			//},
			{
				name: 'BSNES',
				path: '/retroarch/cores/bsnes_libretro_libnx.nro',
			},
		],
	},
	{
		name: 'Nintendo 64 (N64)',
		cores: [
			{
				name: 'Mupen64Plus',
				path: '/retroarch/cores/mupen64plus_next_libretro_libnx.nro',
			},
		],
	},
	{
		name: 'Nintendo 3DS',
		cores: [
			{
				name: 'Citra',
				path: '/retroarch/cores/citra_libretro_libnx.nro',
			},
		],
	},
	{
		name: 'Game Boy (GB / GBC)',
		cores: [
			{
				name: 'Gambatte',
				path: '/retroarch/cores/gambatte_libretro_libnx.nro',
			},
		],
	},
	{
		name: 'Game Boy Advance (GBA)',
		cores: [
			{
				name: 'mGBA',
				path: '/retroarch/cores/mgba_libretro_libnx.nro',
			},
			{
				name: 'mGBA (Standalone)',
				path: '/switch/mgba.nro',
			},
		],
	},
	{
		name: 'Genesis (GEN)',
		cores: [
			{
				name: 'PicoDrive',
				path: '/retroarch/cores/picodrive_libretro_libnx.nro',
			},
		],
	},
	{
		name: 'Playstation (PSX)',
		cores: [
			{
				name: 'PCSX ReARMed',
				path: '/retroarch/cores/pcsx_rearmed_libretro_libnx.nro',
			},
		],
	},
	{
		name: 'Playstation Portable (PSP)',
		cores: [
			{
				name: 'PPSSPP (Standalone, GL)',
				path: '/switch/PPSSPP_GL.nro',
			},
			{
				name: 'PPSSPP (Standalone, GLES2)',
				path: '/switch/ppsspp/PPSSPP_GLES2.nro',
			},
			//{
			//	name: 'PPSSPP (RetroArch)',
			//	path: '/retroarch/cores/ppsspp_libretro_libnx.nro',
			//},
		],
	},
];

export interface PresetsDropdownProps {
	value: string;
	onSelect: (v: string) => void;
}

export function PresetsDropdown({ value, onSelect }: PresetsDropdownProps) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					title="Presets"
					tabIndex={-1}
					className="absolute right-0 h-9 rounded-l-none border-l border-input"
				>
					<Menu className="size-4" />
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent
				sideOffset={5}
				className="max-h-[400px] overflow-y-auto"
			>
				<DropdownMenuRadioGroup value={value} onValueChange={onSelect}>
					{systems.map((system, i) => (
						<PresetsDropdownSystem
							key={system.name}
							system={system}
							separator={i < systems.length - 1}
						/>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface PresetsDropdownSystemProps {
	system: SystemData;
	separator: boolean;
}

function PresetsDropdownSystem({
	system,
	separator,
}: PresetsDropdownSystemProps) {
	return (
		<>
			<DropdownMenuLabel>{system.name}</DropdownMenuLabel>
			{system.cores.map((core) => (
				<PresetsDropdownCore key={core.path} core={core} />
			))}
			{separator ? <DropdownMenuSeparator /> : null}
		</>
	);
}

interface PresetsDropdownCoreProps {
	core: CoreData;
}

function PresetsDropdownCore({ core }: PresetsDropdownCoreProps) {
	return (
		<DropdownMenuRadioItem value={core.path}>
			{core.name}
		</DropdownMenuRadioItem>
	);
}
